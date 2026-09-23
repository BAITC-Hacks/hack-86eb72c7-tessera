import "server-only"

import { createHash, randomUUID } from "node:crypto"
import {
  GetBucketOwnershipControlsCommand,
  GetPublicAccessBlockCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

export const MAX_OBJECT_BYTES = 25 * 1024 * 1024
export const MAX_SIGNED_SECONDS = 300

export type ObjectPurpose = "source" | "report" | "export"
export type StorageOperation = "upload" | "download"

export type UploadedObject = {
  id: string
  projectId: string
  purpose: ObjectPurpose
  key: string
  contentType: string
  sizeBytes: number
  sha256Hex: string
  confirmed: boolean
}

export type StoredObject = UploadedObject

export type StorageAuthorization = (input: {
  userId: string
  projectId: string
  operation: StorageOperation
}) => Promise<"active" | "archived" | null>

export type StorageOptions = {
  client: S3Client
  bucket: string
  authorizeProject: StorageAuthorization
  resolveObject: (input: {
    userId: string
    projectId: string
    objectId: string
  }) => Promise<StoredObject | null>
  signDownload?: (client: S3Client, command: GetObjectCommand, expiresIn: number) => Promise<string>
  now?: () => Date
}

export class StorageError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "NOT_FOUND" | "ARCHIVED" | "UNSAFE_BUCKET" | "INTEGRITY_FAILED" | "STORAGE_UNAVAILABLE") {
    super({
      INVALID_INPUT: "Некорректные параметры файла.",
      NOT_FOUND: "Файл или проект не найден.",
      ARCHIVED: "Архивный проект нельзя изменять.",
      UNSAFE_BUCKET: "Закрытость хранилища не подтверждена.",
      INTEGRITY_FAILED: "Целостность файла не подтверждена.",
      STORAGE_UNAVAILABLE: "Хранилище временно недоступно.",
    }[code])
    this.name = "StorageError"
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sha256Pattern = /^[0-9a-f]{64}$/
const contentTypes: Record<ObjectPurpose, readonly string[]> = {
  source: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/csv", "application/zip"],
  report: ["application/json", "text/csv"],
  export: ["text/csv"],
}
const prefixes: Record<ObjectPurpose, string> = {
  source: "sources",
  report: "reports",
  export: "exports",
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value)
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && sha256Pattern.test(value)
}

function objectKey(projectId: string, purpose: ObjectPurpose, objectId: string): string {
  return `projects/${projectId}/${prefixes[purpose]}/${objectId}`
}

function validateMetadata(object: UploadedObject): void {
  const keyParts = typeof object?.key === "string" ? object.key.split("/") : []
  if (!object || typeof object !== "object" || !validUuid(object.id) || !validUuid(object.projectId) ||
      !Object.hasOwn(prefixes, object.purpose) || keyParts.length !== 4 ||
      object.key !== objectKey(object.projectId, object.purpose, object.id) ||
      !contentTypes[object.purpose].includes(object.contentType) ||
      !Number.isSafeInteger(object.sizeBytes) || object.sizeBytes < 1 || object.sizeBytes > MAX_OBJECT_BYTES ||
      !validSha256(object.sha256Hex) || object.confirmed !== true) {
    throw new StorageError("INTEGRITY_FAILED")
  }
}

function readFailure(error: unknown): StorageError {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
  const status = error && typeof error === "object" && "$metadata" in error
    ? Number((error.$metadata as { httpStatusCode?: number })?.httpStatusCode) : NaN
  return new StorageError(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED"].includes(code) || status >= 500
    ? "STORAGE_UNAVAILABLE" : "INTEGRITY_FAILED")
}

export function createPrivateStorage(options: StorageOptions) {
  if (!options.client || typeof options.bucket !== "string" ||
      typeof options.authorizeProject !== "function" || typeof options.resolveObject !== "function" ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) {
    throw new StorageError("INVALID_INPUT")
  }
  const { client, bucket, authorizeProject, resolveObject } = options
  const now = options.now ?? (() => new Date())
  const signDownload = options.signDownload ?? ((s3: S3Client, command: GetObjectCommand, expiresIn: number) =>
    getSignedUrl(s3, command, { expiresIn }))

  async function assertPrivateBucket(): Promise<void> {
    try {
      const [block, ownership] = await Promise.all([
        client.send(new GetPublicAccessBlockCommand({ Bucket: bucket })),
        client.send(new GetBucketOwnershipControlsCommand({ Bucket: bucket })),
      ])
      const config = block.PublicAccessBlockConfiguration
      const enforced = ownership.OwnershipControls?.Rules?.some(rule => rule.ObjectOwnership === "BucketOwnerEnforced")
      if (!config?.BlockPublicAcls || !config.IgnorePublicAcls || !config.BlockPublicPolicy ||
          !config.RestrictPublicBuckets || !enforced) {
        throw new StorageError("UNSAFE_BUCKET")
      }
    } catch {
      throw new StorageError("UNSAFE_BUCKET")
    }
  }

  async function assertAuthorized(userId: string, projectId: string, operation: StorageOperation): Promise<void> {
    if (typeof userId !== "string" || !userId.trim() || !validUuid(projectId)) throw new StorageError("INVALID_INPUT")
    let state
    try {
      state = await authorizeProject({ userId, projectId, operation })
    } catch {
      throw new StorageError("STORAGE_UNAVAILABLE")
    }
    if (state === null) throw new StorageError("NOT_FOUND")
    if (state !== "active" && state !== "archived") throw new StorageError("NOT_FOUND")
    if (state === "archived" && operation === "upload") throw new StorageError("ARCHIVED")
  }

  async function verifyHead(object: UploadedObject): Promise<void> {
    let head
    try {
      head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: object.key, ChecksumMode: "ENABLED" }))
    } catch {
      throw new StorageError("INTEGRITY_FAILED")
    }
    const metadata = head.Metadata
    const checksum = Buffer.from(object.sha256Hex, "hex").toString("base64")
    if (head.ContentLength !== object.sizeBytes || head.ContentType !== object.contentType ||
        head.ChecksumSHA256 !== checksum || metadata?.["project-id"] !== object.projectId ||
        metadata?.purpose !== object.purpose || metadata?.["sha256-hex"] !== object.sha256Hex) {
      throw new StorageError("INTEGRITY_FAILED")
    }
  }

  return {
    assertPrivateBucket,

    async readSource(input: { userId: string; projectId: string; objectId: string }): Promise<Uint8Array> {
      await assertAuthorized(input.userId, input.projectId, "download")
      if (!validUuid(input.objectId)) throw new StorageError("INVALID_INPUT")
      const object = await resolveObject(input)
      if (!object || object.id !== input.objectId || object.projectId !== input.projectId || object.purpose !== "source")
        throw new StorageError("NOT_FOUND")
      validateMetadata(object)
      await assertPrivateBucket()
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: object.key, ChecksumMode: "ENABLED" }))
        const metadata = head.Metadata
        const expected = Buffer.from(object.sha256Hex, "hex").toString("base64")
        if (head.ContentLength !== object.sizeBytes || head.ContentType !== object.contentType ||
            metadata?.["project-id"] !== object.projectId || metadata?.purpose !== "source" ||
            metadata?.["sha256-hex"] !== object.sha256Hex ||
            (head.ChecksumType !== "COMPOSITE" && head.ChecksumSHA256 && head.ChecksumSHA256 !== expected))
          throw new StorageError("INTEGRITY_FAILED")
      } catch (error) {
        if (error instanceof StorageError) throw error
        throw readFailure(error)
      }
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: object.key }))
        if (!response.Body) throw new Error("empty body")
        const chunks: Uint8Array[] = []
        let length = 0
        for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
          length += chunk.length
          if (length > MAX_OBJECT_BYTES || length > object.sizeBytes) throw new Error("oversize")
          chunks.push(chunk)
        }
        const bytes = Buffer.concat(chunks, length)
        if (length !== object.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== object.sha256Hex)
          throw new Error("checksum")
        return bytes
      } catch (error) {
        if (error instanceof StorageError) throw error
        throw readFailure(error)
      }
    },

    async readImportReport(input: { userId: string; projectId: string; objectId: string }): Promise<unknown> {
      await assertAuthorized(input.userId, input.projectId, "download")
      if (!validUuid(input.objectId)) throw new StorageError("INVALID_INPUT")
      const object = await resolveObject(input)
      if (!object || object.id !== input.objectId || object.projectId !== input.projectId || object.purpose !== "report")
        throw new StorageError("NOT_FOUND")
      validateMetadata(object)
      await assertPrivateBucket()
      await verifyHead(object)
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: object.key }))
        if (!response.Body) throw new Error("empty body")
        const chunks: Uint8Array[] = []
        let length = 0
        for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
          length += chunk.length
          if (length > MAX_OBJECT_BYTES || length > object.sizeBytes) throw new Error("oversize")
          chunks.push(chunk)
        }
        const bytes = Buffer.concat(chunks, length)
        if (length !== object.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== object.sha256Hex)
          throw new Error("checksum")
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
      } catch {
        throw new StorageError("INTEGRITY_FAILED")
      }
    },

    async uploadImportReport(input: { userId: string; projectId: string; importId: string; body: Uint8Array }): Promise<UploadedObject> {
      await assertAuthorized(input.userId, input.projectId, "upload")
      if (!validUuid(input.importId) || !(input.body instanceof Uint8Array) ||
          input.body.length < 1 || input.body.length > MAX_OBJECT_BYTES) throw new StorageError("INVALID_INPUT")
      const object: UploadedObject = {
        id: input.importId, projectId: input.projectId, purpose: "report",
        key: objectKey(input.projectId, "report", input.importId), contentType: "application/json",
        sizeBytes: input.body.length,
        sha256Hex: createHash("sha256").update(input.body).digest("hex"), confirmed: true,
      }
      await assertPrivateBucket()
      try {
        await client.send(new PutObjectCommand({
          Bucket: bucket, Key: object.key, Body: input.body, ContentLength: object.sizeBytes,
          ContentType: object.contentType, ChecksumSHA256: Buffer.from(object.sha256Hex, "hex").toString("base64"),
          IfNoneMatch: "*",
          Metadata: { "project-id": object.projectId, purpose: "report", "sha256-hex": object.sha256Hex },
        }))
      } catch (error) {
        const conflict = error instanceof Error && (error.name === "PreconditionFailed" ||
          ("$metadata" in error && (error.$metadata as {httpStatusCode?:number})?.httpStatusCode === 412))
        if (!conflict) throw new StorageError("STORAGE_UNAVAILABLE")
        // A prior attempt may have written the same immutable report before its DB transaction.
      }
      await verifyHead(object)
      return object
    },

    async upload(input: {
      userId: string
      projectId: string
      purpose: ObjectPurpose
      body: Uint8Array
      contentType: string
      sha256Hex: string
    }): Promise<UploadedObject> {
      await assertAuthorized(input.userId, input.projectId, "upload")
      if (!Object.hasOwn(prefixes, input.purpose) || !contentTypes[input.purpose].includes(input.contentType) ||
          !(input.body instanceof Uint8Array) || input.body.byteLength < 1 || input.body.byteLength > MAX_OBJECT_BYTES ||
          !validSha256(input.sha256Hex)) {
        throw new StorageError("INVALID_INPUT")
      }
      const actual = createHash("sha256").update(input.body).digest("hex")
      if (actual !== input.sha256Hex) throw new StorageError("INTEGRITY_FAILED")
      await assertPrivateBucket()
      const object: UploadedObject = {
        id: randomUUID(),
        projectId: input.projectId, purpose: input.purpose,
        key: "",
        contentType: input.contentType, sizeBytes: input.body.byteLength,
        sha256Hex: actual, confirmed: true,
      }
      object.key = objectKey(object.projectId, object.purpose, object.id)
      try {
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: object.key,
          Body: input.body,
          ContentLength: object.sizeBytes,
          ContentType: object.contentType,
          ChecksumSHA256: Buffer.from(actual, "hex").toString("base64"),
          IfNoneMatch: "*",
          Metadata: { "project-id": object.projectId, purpose: object.purpose, "sha256-hex": actual },
        }))
      } catch {
        throw new StorageError("STORAGE_UNAVAILABLE")
      }
      await verifyHead(object)
      return object
    },

    async confirm(input: { userId: string; projectId: string; object: UploadedObject }): Promise<UploadedObject> {
      await assertAuthorized(input.userId, input.projectId, "upload")
      if (!input.object || typeof input.object !== "object" || input.object.projectId !== input.projectId) throw new StorageError("NOT_FOUND")
      validateMetadata(input.object)
      await assertPrivateBucket()
      await verifyHead(input.object)
      return input.object
    },

    async getDownloadUrl(input: {
      userId: string
      projectId: string
      objectId: string
      expiresIn?: number
    }): Promise<{ url: string; expiresAt: string }> {
      await assertAuthorized(input.userId, input.projectId, "download")
      if (!validUuid(input.objectId)) throw new StorageError("INVALID_INPUT")
      let object
      try {
        object = await resolveObject({ userId: input.userId, projectId: input.projectId, objectId: input.objectId })
      } catch {
        throw new StorageError("STORAGE_UNAVAILABLE")
      }
      if (!object || !validUuid(object.id) || object.id !== input.objectId || object.projectId !== input.projectId) throw new StorageError("NOT_FOUND")
      validateMetadata(object)
      const expiresIn = input.expiresIn ?? MAX_SIGNED_SECONDS
      if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_SIGNED_SECONDS) {
        throw new StorageError("INVALID_INPUT")
      }
      await assertPrivateBucket()
      await verifyHead(object)
      try {
        const url = await signDownload(client, new GetObjectCommand({ Bucket: bucket, Key: object.key }), expiresIn)
        if (!url.startsWith("https://")) throw new Error("Небезопасный адрес")
        return { url, expiresAt: new Date(now().getTime() + expiresIn * 1000).toISOString() }
      } catch {
        throw new StorageError("STORAGE_UNAVAILABLE")
      }
    },
  }
}
