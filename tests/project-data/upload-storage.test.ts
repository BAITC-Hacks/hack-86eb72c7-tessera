import assert from "node:assert/strict"
import test from "node:test"
import { GetBucketOwnershipControlsCommand, GetPublicAccessBlockCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { createUploadStorage } from "../../lib/server/imports/upload-storage"

const key = "projects/11111111-1111-4111-8111-111111111111/sources/22222222-2222-4222-8222-222222222222"
const checksum = "a".repeat(64)
const input = { key, checksum, sizeBytes: 12, contentType: "text/csv" }
function fixture(head: Record<string, unknown> = {}, privateBucket = true) {
  const client = new S3Client({ region: "eu-central-1" })
  client.send = (async (command: unknown) => {
    if (command instanceof GetPublicAccessBlockCommand) return { PublicAccessBlockConfiguration: { BlockPublicAcls: privateBucket, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } }
    if (command instanceof GetBucketOwnershipControlsCommand) return { OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] } }
    if (command instanceof HeadObjectCommand) return { ContentLength: 12, ContentType: "text/csv", ...head }
    throw new Error("Unexpected command")
  }) as typeof client.send
  return client
}

test("signed PUT binds size, checksum, no-overwrite and 300-second expiry", async () => {
  const storage = createUploadStorage({ client: fixture(), bucket: "private-test", now: () => new Date("2026-09-23T00:00:00Z"), sign: async (_client, command, expires) => {
    assert.equal(expires, 300)
    assert.equal(command.input.IfNoneMatch, "*")
    assert.equal(command.input.ContentLength, 12)
    assert.equal(command.input.ChecksumSHA256, Buffer.from(checksum, "hex").toString("base64"))
    assert.equal(command.input.ACL, undefined)
    return "https://private-test.example/upload"
  } })
  const upload = await storage.signUpload(input)
  assert.equal(upload.expiresAt, "2026-09-23T00:05:00.000Z")
  assert.equal(upload.headers["if-none-match"], "*")
})

test("oversize, arbitrary paths and unsafe buckets fail closed", async () => {
  const storage = createUploadStorage({ client: fixture(), bucket: "private-test" })
  await assert.rejects(storage.signUpload({ ...input, sizeBytes: 25 * 1024 * 1024 + 1 }))
  await assert.rejects(storage.head({ key: "https://attacker.example/object" }))
  await assert.rejects(createUploadStorage({ client: fixture({}, false), bucket: "private-test" }).signUpload(input), { code: "UNSAFE_BUCKET" })
})

test("HEAD trusts service SHA256 but never metadata, ETag or composite checksum", async () => {
  for (const head of [{ ETag: checksum, Metadata: { "sha256-hex": checksum } }, { ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64"), ChecksumType: "COMPOSITE" }]) {
    const result = await createUploadStorage({ client: fixture(head), bucket: "private-test" }).head({ key })
    assert.equal(result.checksum, null)
    assert.equal(result.checksumPending, true)
  }
  const result = await createUploadStorage({ client: fixture({ ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64"), ChecksumType: "FULL_OBJECT" }), bucket: "private-test" }).head({ key })
  assert.equal(result.checksum, checksum)
  assert.equal(result.checksumPending, false)
})
