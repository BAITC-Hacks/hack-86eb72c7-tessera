import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { test } from "node:test"
import {
  GetBucketOwnershipControlsCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { createPrivateStorage, MAX_OBJECT_BYTES, StorageError, type StoredObject } from "../../lib/server/storage"

const projectId = randomUUID()
const userId = "user_test"
const body = Buffer.from("тестовый файл")
const sha256Hex = createHash("sha256").update(body).digest("hex")

type MockState = {
  calls: object[]
  object: StoredObject | null
  status: "active" | "archived" | null
  privateBucket: boolean
  missingBlock: boolean
  enforcedOwnership: boolean
  putError: boolean
  headError: boolean
  authError: boolean
  resolveError: boolean
  signError: boolean
  headOverride: object | null
  ttl: number | null
}

function harness() {
  const state: MockState = {
    calls: [], object: null, status: "active", privateBucket: true, missingBlock: false,
    enforcedOwnership: true, putError: false, headError: false, authError: false,
    resolveError: false, signError: false, headOverride: null, ttl: null,
  }
  async function mockSend(command: object): Promise<object> {
      state.calls.push(command)
      if (command instanceof GetPublicAccessBlockCommand) {
        if (state.missingBlock) throw new Error("private service detail")
        const enabled = state.privateBucket
        return { PublicAccessBlockConfiguration: {
          BlockPublicAcls: enabled, IgnorePublicAcls: enabled,
          BlockPublicPolicy: enabled, RestrictPublicBuckets: enabled,
        } }
      }
      if (command instanceof GetBucketOwnershipControlsCommand) {
        return { OwnershipControls: { Rules: [{ ObjectOwnership: state.enforcedOwnership ? "BucketOwnerEnforced" : "ObjectWriter" }] } }
      }
      if (command instanceof PutObjectCommand) {
        if (state.putError) throw new Error("private service detail")
        return {}
      }
      if (command instanceof HeadObjectCommand) {
        if (state.headError) throw new Error("private service detail")
        if (state.headOverride) return state.headOverride
        const object = state.object
        if (!object) throw new Error("Нет объекта")
        return {
          ContentLength: object.sizeBytes,
          ContentType: object.contentType,
          ChecksumSHA256: Buffer.from(object.sha256Hex, "hex").toString("base64"),
          Metadata: { "project-id": object.projectId, purpose: object.purpose, "sha256-hex": object.sha256Hex },
        }
      }
      if (command instanceof GetObjectCommand) {
        return { Body: (async function* () { yield body })() }
      }
      throw new Error("Неожиданная команда")
  }
  const client = { send: mockSend } as unknown as S3Client
  const storage = createPrivateStorage({
    client, bucket: "private-test-bucket",
    authorizeProject: async input => {
      if (state.authError) throw new Error("private auth detail")
      return input.userId === userId && input.projectId === projectId ? state.status : null
    },
    resolveObject: async input => {
      if (state.resolveError) throw new Error("private db detail")
      return input.objectId === state.object?.id ? state.object : null
    },
    signDownload: async (_client, command, expiresIn) => {
      if (state.signError) throw new Error("private signer detail")
      assert.ok(command instanceof GetObjectCommand)
      state.ttl = expiresIn
      return "https://private.example.test/signed"
    },
    now: () => new Date("2026-09-23T00:00:00.000Z"),
  })
  async function upload() {
    // Имитируем, что S3 сохранил объект, но HEAD строим после записи по полученному ключу.
    const wrapped = client as unknown as { send: (command: object) => Promise<object> }
    wrapped.send = async command => {
      if (command instanceof PutObjectCommand) {
        const key = command.input.Key ?? ""
        state.object = {
          id: key.split("/").at(-1) ?? "", projectId,
          purpose: command.input.Metadata?.purpose as StoredObject["purpose"],
          key, sizeBytes: command.input.ContentLength ?? 0,
          contentType: command.input.ContentType ?? "",
          sha256Hex: command.input.Metadata?.["sha256-hex"] ?? "", confirmed: true,
        }
      }
      return mockSend(command)
    }
    await storage.upload({ userId, projectId, purpose: "source", body, contentType: "text/csv", sha256Hex })
    assert.ok(state.object)
    return state.object
  }
  return { storage, state, upload }
}

async function rejectsCode(promise: Promise<unknown>, code: StorageError["code"]) {
  await assert.rejects(promise, error => error instanceof StorageError && error.code === code)
}

test("загрузка создаёт закрытый одноразовый ключ и сверяет S3 HEAD", async () => {
  const { storage, state, upload } = harness()
  const object = await upload()
  assert.match(object.key, new RegExp(`^projects/${projectId}/sources/[0-9a-f-]{36}$`))
  assert.equal(object.id, object.key.split("/").at(-1))
  const put = state.calls.find(call => call instanceof PutObjectCommand) as PutObjectCommand
  assert.equal(put.input.IfNoneMatch, "*")
  assert.equal(put.input.ChecksumSHA256, Buffer.from(sha256Hex, "hex").toString("base64"))
  assert.equal(put.input.ContentLength, body.byteLength)
  assert.equal(put.input.ACL, undefined)
  assert.equal(put.input.Metadata?.["project-id"], projectId)
  assert.ok(state.calls.some(call => call instanceof HeadObjectCommand && call.input.ChecksumMode === "ENABLED"))
  assert.deepEqual(await storage.confirm({ userId, projectId, object }), object)
})

test("ссылка выдаётся только по сохранённому объекту после авторизации и проверки", async () => {
  const { storage, state, upload } = harness()
  const object = await upload()
  assert.deepEqual(await storage.getDownloadUrl({ userId, projectId, objectId: object.id, expiresIn: 120 }), {
    url: "https://private.example.test/signed", expiresAt: "2026-09-23T00:02:00.000Z",
  })
  assert.equal(state.ttl, 120)
  await rejectsCode(storage.getDownloadUrl({ userId: "other", projectId, objectId: object.id }), "NOT_FOUND")
  await rejectsCode(storage.getDownloadUrl({ userId, projectId: randomUUID(), objectId: object.id }), "NOT_FOUND")
  await rejectsCode(storage.getDownloadUrl({ userId, projectId, objectId: "../../other" }), "INVALID_INPUT")
  await rejectsCode(storage.getDownloadUrl({ userId, projectId, objectId: randomUUID() }), "NOT_FOUND")
  for (const expiresIn of [0, 301, 1.5, -1]) {
    await rejectsCode(storage.getDownloadUrl({ userId, projectId, objectId: object.id, expiresIn }), "INVALID_INPUT")
  }
})

test("архив, открытый bucket, размер и тип блокируют запись", async () => {
  const { storage, state, upload } = harness()
  state.status = "archived"
  await rejectsCode(upload(), "ARCHIVED")
  state.status = "active"
  state.privateBucket = false
  await rejectsCode(upload(), "UNSAFE_BUCKET")
  state.privateBucket = true
  await rejectsCode(storage.upload({ userId, projectId, purpose: "source", body: new Uint8Array(MAX_OBJECT_BYTES + 1), contentType: "text/csv", sha256Hex }), "INVALID_INPUT")
  await rejectsCode(storage.upload({ userId, projectId, purpose: "source", body, contentType: "text/html", sha256Hex }), "INVALID_INPUT")
  await rejectsCode(storage.upload({ userId, projectId, purpose: "source", body, contentType: "text/csv", sha256Hex: "0".repeat(64) }), "INTEGRITY_FAILED")
  assert.equal(state.calls.filter(call => call instanceof PutObjectCommand).length, 0)
})

test("чужие метаданные, повреждение S3 и неподтверждённый объект не дают ссылку", async () => {
  const { storage, state, upload } = harness()
  const object = await upload()
  state.object = { ...object, key: "../escape" }
  await rejectsCode(storage.getDownloadUrl({ userId, projectId, objectId: object.id }), "INTEGRITY_FAILED")
  state.object = { ...object, confirmed: false }
  await rejectsCode(storage.getDownloadUrl({ userId, projectId, objectId: object.id }), "INTEGRITY_FAILED")
  state.object = object
  state.headOverride = { ContentLength: object.sizeBytes, ContentType: object.contentType, ChecksumSHA256: "wrong", Metadata: {} }
  await rejectsCode(storage.getDownloadUrl({ userId, projectId, objectId: object.id }), "INTEGRITY_FAILED")
  state.headOverride = null
  state.privateBucket = false
  await rejectsCode(storage.getDownloadUrl({ userId, projectId, objectId: object.id }), "UNSAFE_BUCKET")
})

test("враждебные значения не обходят назначение и не выбрасывают сырые TypeError", async () => {
  const { storage, upload } = harness()
  await upload()
  for (const purpose of ["constructor", "toString", "__proto__", "../../source"]) {
    await rejectsCode(storage.upload({ userId, projectId, purpose: purpose as "source", body, contentType: "text/csv", sha256Hex }), "INVALID_INPUT")
  }
  await rejectsCode(storage.upload({ userId: 1 as unknown as string, projectId, purpose: "source", body, contentType: "text/csv", sha256Hex }), "INVALID_INPUT")
  await rejectsCode(storage.upload({ userId, projectId: 1 as unknown as string, purpose: "source", body, contentType: "text/csv", sha256Hex }), "INVALID_INPUT")
  await rejectsCode(storage.upload({ userId, projectId, purpose: "source", body, contentType: "text/csv", sha256Hex: 1 as unknown as string }), "INVALID_INPUT")
  await rejectsCode(storage.getDownloadUrl({ userId, projectId, objectId: 1 as unknown as string }), "INVALID_INPUT")
  await rejectsCode(storage.confirm({ userId, projectId, object: null as unknown as StoredObject }), "NOT_FOUND")
})

test("отсутствие проверки bucket и невыключенные ACL закрывают доступ", async () => {
  const { state, upload } = harness()
  state.missingBlock = true
  await rejectsCode(upload(), "UNSAFE_BUCKET")
  state.missingBlock = false
  state.enforcedOwnership = false
  await rejectsCode(upload(), "UNSAFE_BUCKET")
  assert.equal(state.calls.filter(call => call instanceof PutObjectCommand).length, 0)
})

test("HEAD сверяет размер и MIME и не раскрывает подробности ошибки поставщика", async () => {
  const { storage, state, upload } = harness()
  const object = await upload()
  const goodHead = {
    ContentLength: object.sizeBytes,
    ContentType: object.contentType,
    ChecksumSHA256: Buffer.from(object.sha256Hex, "hex").toString("base64"),
    Metadata: { "project-id": object.projectId, purpose: object.purpose, "sha256-hex": object.sha256Hex },
  }
  state.headOverride = { ...goodHead, ContentLength: object.sizeBytes + 1 }
  await rejectsCode(storage.getDownloadUrl({ userId, projectId, objectId: object.id }), "INTEGRITY_FAILED")
  state.headOverride = { ...goodHead, ContentType: "text/html" }
  await rejectsCode(storage.getDownloadUrl({ userId, projectId, objectId: object.id }), "INTEGRITY_FAILED")
  state.headOverride = null
  state.headError = true
  await assert.rejects(storage.getDownloadUrl({ userId, projectId, objectId: object.id }), error =>
    error instanceof StorageError && error.code === "INTEGRITY_FAILED" && !error.message.includes("private"))
})

test("ошибки записи, авторизации, базы и подписи очищаются", async () => {
  const { storage, state, upload } = harness()
  state.authError = true
  await assert.rejects(upload(), error => error instanceof StorageError && error.code === "STORAGE_UNAVAILABLE" && !error.message.includes("private"))
  state.authError = false
  state.putError = true
  await assert.rejects(upload(), error => error instanceof StorageError && error.code === "STORAGE_UNAVAILABLE" && !error.message.includes("private"))
  state.putError = false
  const object = await upload()
  state.resolveError = true
  await rejectsCode(storage.getDownloadUrl({ userId, projectId, objectId: object.id }), "STORAGE_UNAVAILABLE")
  state.resolveError = false
  state.signError = true
  await rejectsCode(storage.getDownloadUrl({ userId, projectId, objectId: object.id }), "STORAGE_UNAVAILABLE")
})

test("границы размера, срока и подтверждение в архиве", async () => {
  const { storage, state, upload } = harness()
  const object = await upload()
  state.status = "archived"
  await rejectsCode(storage.confirm({ userId, projectId, object }), "ARCHIVED")
  assert.equal((await storage.getDownloadUrl({ userId, projectId, objectId: object.id, expiresIn: 1 })).expiresAt, "2026-09-23T00:00:01.000Z")
  assert.equal((await storage.getDownloadUrl({ userId, projectId, objectId: object.id, expiresIn: 300 })).expiresAt, "2026-09-23T00:05:00.000Z")
  state.status = "active"
  await rejectsCode(storage.upload({ userId, projectId, purpose: "source", body: new Uint8Array(), contentType: "text/csv", sha256Hex }), "INVALID_INPUT")
  const maxBody = new Uint8Array(MAX_OBJECT_BYTES)
  const maxSha = createHash("sha256").update(maxBody).digest("hex")
  const maxObject = await storage.upload({ userId, projectId, purpose: "source", body: maxBody, contentType: "text/csv", sha256Hex: maxSha })
  assert.equal(maxObject.sizeBytes, MAX_OBJECT_BYTES)
})

test("worker сверяет байты источника, когда S3 не выдаёт подтверждённый checksum", async () => {
  const { storage, state, upload } = harness()
  const object = await upload()
  state.headOverride = {
    ContentLength: object.sizeBytes, ContentType: object.contentType,
    Metadata: { "project-id": object.projectId, purpose: "source", "sha256-hex": object.sha256Hex },
  }
  assert.deepEqual(await storage.readSource({ userId, projectId, objectId: object.id }), body)
  state.headOverride = { ...state.headOverride, ContentLength: object.sizeBytes + 1 }
  await rejectsCode(storage.readSource({ userId, projectId, objectId: object.id }), "INTEGRITY_FAILED")
  await rejectsCode(storage.readSource({ userId: "other", projectId, objectId: object.id }), "NOT_FOUND")
})
