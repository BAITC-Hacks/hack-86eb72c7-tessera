import "server-only"

import { GetBucketOwnershipControlsCommand, GetPublicAccessBlockCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { MAX_OBJECT_BYTES, MAX_SIGNED_SECONDS, StorageError } from "../storage"

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
const keyPattern = new RegExp(`^projects/${uuid}/sources/${uuid}$`, "i")
const contentTypes = new Set(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/csv", "application/zip"])

export type UploadSource = { projectId: string; sourceObjectId: string; fileName: string; size: number; contentType: string; checksum: string }
export type UploadInput = { key: string; sizeBytes: number; checksum: string; contentType: string }
export type UploadStorageOptions = {
  client: S3Client
  bucket: string
  now?: () => Date
  sign?: (client: S3Client, command: PutObjectCommand, expiresIn: number) => Promise<string>
}

/** Вызывать только после проверки владельца; ключ создаёт сервис, не HTTP-клиент. */
export function createUploadStorage({ client, bucket, sign, now = () => new Date() }: UploadStorageOptions) {
  if (!client || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new StorageError("INVALID_INPUT")
  const signer = sign ?? ((s3: S3Client, command: PutObjectCommand, expiresIn: number) => getSignedUrl(s3, command, {
    expiresIn,
    signableHeaders: new Set(["content-type", "content-length", "if-none-match"]),
    unhoistableHeaders: new Set(["x-amz-checksum-sha256", "x-amz-meta-sha256-hex", "x-amz-meta-project-id", "x-amz-meta-purpose"]),
  }))
  async function assertPrivateBucket() {
    try {
      const [block, ownership] = await Promise.all([
        client.send(new GetPublicAccessBlockCommand({ Bucket: bucket })),
        client.send(new GetBucketOwnershipControlsCommand({ Bucket: bucket })),
      ])
      const config = block.PublicAccessBlockConfiguration
      if (!config?.BlockPublicAcls || !config.IgnorePublicAcls || !config.BlockPublicPolicy || !config.RestrictPublicBuckets ||
          !ownership.OwnershipControls?.Rules?.some(rule => rule.ObjectOwnership === "BucketOwnerEnforced")) throw new Error()
    } catch { throw new StorageError("UNSAFE_BUCKET") }
  }
  function validKey(key: string) {
    if (typeof key !== "string" || !keyPattern.test(key)) throw new StorageError("INVALID_INPUT")
  }
  const storage = {
    async signUpload(input: UploadInput) {
      validKey(input.key)
      if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_OBJECT_BYTES ||
          !/^[a-f0-9]{64}$/.test(input.checksum) || !contentTypes.has(input.contentType)) throw new StorageError("INVALID_INPUT")
      await assertPrivateBucket()
      const checksum = Buffer.from(input.checksum, "hex").toString("base64")
      const projectId = input.key.split("/")[1]
      const headers = {
        "content-type": input.contentType, "content-length": String(input.sizeBytes), "if-none-match": "*",
        "x-amz-checksum-sha256": checksum, "x-amz-meta-sha256-hex": input.checksum,
        "x-amz-meta-project-id": projectId, "x-amz-meta-purpose": "source",
      }
      try {
        const url = await signer(client, new PutObjectCommand({
          Bucket: bucket, Key: input.key, ContentType: input.contentType, ContentLength: input.sizeBytes,
          ChecksumSHA256: checksum, IfNoneMatch: "*",
          Metadata: { "sha256-hex": input.checksum, "project-id": projectId, purpose: "source" },
        }), MAX_SIGNED_SECONDS)
        if (new URL(url).protocol !== "https:") throw new Error()
        return { url, method: "PUT" as const, headers, expiresAt: new Date(now().getTime() + MAX_SIGNED_SECONDS * 1000).toISOString() }
      } catch { throw new StorageError("STORAGE_UNAVAILABLE") }
    },
    async head({ key }: { key: string }) {
      validKey(key)
      await assertPrivateBucket()
      try {
        const object = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: "ENABLED" }))
        if (!Number.isSafeInteger(object.ContentLength) || !object.ContentLength || object.ContentLength > MAX_OBJECT_BYTES ||
            !object.ContentType || !contentTypes.has(object.ContentType)) throw new StorageError("INTEGRITY_FAILED")
        // Metadata и ETag не являются доказательством контрольной суммы байтов.
        const trusted = object.ChecksumType !== "COMPOSITE" && typeof object.ChecksumSHA256 === "string" &&
          /^[A-Za-z0-9+/]{43}=$/.test(object.ChecksumSHA256) && Buffer.from(object.ChecksumSHA256, "base64").length === 32
        const checksum = trusted ? Buffer.from(object.ChecksumSHA256!, "base64").toString("hex") : null
        return { sizeBytes: object.ContentLength, contentType: object.ContentType, checksum, checksumPending: checksum === null }
      } catch (error) {
        if (error instanceof StorageError) throw error
        throw new StorageError("INTEGRITY_FAILED")
      }
    },
  }
  return {
    ...storage,
    prepareUpload(input: UploadSource) {
      return storage.signUpload({ key: `projects/${input.projectId}/sources/${input.sourceObjectId}`, sizeBytes: input.size, contentType: input.contentType, checksum: input.checksum })
    },
    async confirmUpload(input: UploadSource) {
      const result = await storage.head({ key: `projects/${input.projectId}/sources/${input.sourceObjectId}` })
      if (result.sizeBytes !== input.size || result.contentType !== input.contentType || result.checksum !== input.checksum) throw new StorageError("INTEGRITY_FAILED")
      return result
    },
  }
}

export type UploadStorage = ReturnType<typeof createUploadStorage>
