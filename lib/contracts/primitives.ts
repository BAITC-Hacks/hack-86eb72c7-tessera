import { z } from "zod";

const decimalPattern = /^(?:0|[1-9]\d{0,21})(?:\.\d{0,7}[1-9])?$/;
const signedDecimalPattern = /^-?(?:0|[1-9]\d{0,21})(?:\.\d{0,7}[1-9])?$/;

/** Canonical JSON representation of PostgreSQL numeric(30,8). */
export const DecimalStringSchema = z.string().regex(signedDecimalPattern, "Некорректная десятичная строка").refine(
  (value) => value !== "-0",
  "Отрицательный ноль запрещён",
);
export const NonNegativeDecimalStringSchema = z.string().regex(decimalPattern, "Требуется неотрицательная десятичная строка");
export const PositiveDecimalStringSchema = NonNegativeDecimalStringSchema.refine((value) => value !== "0", "Требуется положительное значение");
export const UuidSchema = z.uuid();
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "Некорректная контрольная сумма SHA-256");
export const IsoDateSchema = z.iso.date().refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Некорректная календарная дата");
export const IsoMonthSchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/, "Некорректный месячный период");
export const UtcTimestampSchema = z.iso.datetime({ offset: false }).refine(
  (value) => value.endsWith("Z") && !Number.isNaN(Date.parse(value)),
  "Требуется время UTC",
);
export const VersionSchema = z.string().min(1).max(100);
export const SourceKeySchema = z.string().min(1).max(200);
export const SafeTextSchema = z.string().trim().min(1).max(2000);
export const NonNegativeIntSchema = z.int().nonnegative();
export const PositiveIntSchema = z.int().positive();
export const AnonymizedCustomerKeySchema = z.string().regex(/^anon_[A-Za-z0-9_-]{1,100}$/, "Требуется обезличенный ключ клиента");

export type DecimalString = z.infer<typeof DecimalStringSchema>;
