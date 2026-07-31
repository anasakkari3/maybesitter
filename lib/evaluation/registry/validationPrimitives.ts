import type { Checksum, IssueSeverity, ValidationIssue, ValidationResult } from './contracts';

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class IssueCollector {
  private readonly collected: ValidationIssue[] = [];

  add(severity: IssueSeverity, code: string, path: string, message: string): void {
    this.collected.push({ code, severity, path, message });
  }

  error(code: string, path: string, message: string): void {
    this.add('error', code, path, message);
  }

  warn(code: string, path: string, message: string): void {
    this.add('warning', code, path, message);
  }

  merge(issues: readonly ValidationIssue[]): void {
    this.collected.push(...issues);
  }

  result(): ValidationResult {
    return {
      valid: !this.collected.some((issue) => issue.severity === 'error'),
      issues: this.collected.slice(),
    };
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isSemver(value: unknown): boolean {
  return typeof value === 'string' && SEMVER_PATTERN.test(value);
}

export function isSlug(value: unknown): boolean {
  return typeof value === 'string' && SLUG_PATTERN.test(value);
}

export function isIsoTimestamp(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && /\d{4}-\d{2}-\d{2}T/.test(value);
}

export function isSha256Hex(value: unknown): boolean {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

export function isValidChecksum(value: unknown): value is Checksum {
  return (
    isPlainObject(value) && value.algorithm === 'sha256' && isSha256Hex(value.value)
  );
}

export function checksumsEqual(a: Checksum, b: Checksum): boolean {
  return a.algorithm === b.algorithm && a.value === b.value;
}

export function isRelativePath(value: unknown): boolean {
  if (!isNonEmptyString(value)) return false;
  if (value.startsWith('/')) return false;
  return !value.split('/').includes('..');
}

export function errorsOf(result: ValidationResult): readonly ValidationIssue[] {
  return result.issues.filter((issue) => issue.severity === 'error');
}

export function hasIssue(result: ValidationResult, code: string): boolean {
  return result.issues.some((issue) => issue.code === code);
}

export function formatIssue(issue: ValidationIssue): string {
  return `${issue.severity.toUpperCase()} ${issue.code} at ${issue.path}: ${issue.message}`;
}
