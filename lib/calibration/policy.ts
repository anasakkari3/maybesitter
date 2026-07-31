import { ANNOTATION_POLICY_CONTRACT_VERSION, CONSISTENCY_DIMENSIONS } from './contracts';
import type {
  AnnotationPolicy,
  AnnotationPolicyRegistry,
  ConsistencyDimension,
  PolicyRuleChange,
} from './contracts';
import type { ValidationResult } from '../evaluation/registry/contracts';
import {
  IssueCollector,
  isIsoTimestamp,
  isNonEmptyString,
  isPlainObject,
  isSemver,
  isSlug,
} from '../evaluation/registry/validationPrimitives';

const SUPPORTED_CONTRACT_MAJOR = ANNOTATION_POLICY_CONTRACT_VERSION.split('.')[0];
const CHANGE_KINDS = ['introduced', 'changed', 'removed'];

function validateRuleChange(collector: IssueCollector, path: string, value: unknown): void {
  if (!isPlainObject(value)) {
    collector.error('POL020', path, 'rule change must be an object');
    return;
  }
  if (!isNonEmptyString(value.ruleId)) {
    collector.error('POL021', `${path}.ruleId`, 'ruleId is required');
  }
  if (typeof value.kind !== 'string' || !CHANGE_KINDS.includes(value.kind)) {
    collector.error('POL022', `${path}.kind`, `unknown rule change kind ${String(value.kind)}`);
  }
  if (!isNonEmptyString(value.statement)) {
    collector.error('POL023', `${path}.statement`, 'a rule change must state the rule in words');
  }
  if (!Array.isArray(value.affects) || value.affects.length === 0) {
    collector.error(
      'POL024',
      `${path}.affects`,
      'a rule change must name the review dimensions it can move, so the consistency instrument can attribute a disagreement to it',
    );
    return;
  }
  for (const dimension of value.affects) {
    if (!(CONSISTENCY_DIMENSIONS as readonly string[]).includes(String(dimension))) {
      collector.error('POL025', `${path}.affects`, `unknown dimension ${String(dimension)}`);
    }
  }
}

export function validateAnnotationPolicyRegistry(value: unknown): ValidationResult {
  const collector = new IssueCollector();

  if (!isPlainObject(value)) {
    collector.error('POL001', 'policies', 'policy registry must be an object');
    return collector.result();
  }

  if (!isSemver(value.contractVersion)) {
    collector.error('POL002', 'policies.contractVersion', 'contractVersion must be semver');
  } else if (String(value.contractVersion).split('.')[0] !== SUPPORTED_CONTRACT_MAJOR) {
    collector.error(
      'POL003',
      'policies.contractVersion',
      `unsupported contract major version ${String(value.contractVersion)}`,
    );
  }

  if (!Array.isArray(value.policies) || value.policies.length === 0) {
    collector.error('POL004', 'policies.policies', 'at least one policy version is required');
    return collector.result();
  }

  const seen = new Set<string>();
  const parsed: AnnotationPolicy[] = [];

  value.policies.forEach((policy, index) => {
    const path = `policies[${index}]`;
    if (!isPlainObject(policy)) {
      collector.error('POL010', path, 'policy must be an object');
      return;
    }

    if (!isSlug(policy.id)) {
      collector.error('POL011', `${path}.id`, 'policy id must be a kebab-case slug');
    }
    if (!isSemver(policy.version)) {
      collector.error('POL012', `${path}.version`, 'policy version must be semver');
    }
    if (!isNonEmptyString(policy.title)) {
      collector.error('POL013', `${path}.title`, 'policy title is required');
    }
    if (!isIsoTimestamp(policy.effectiveFrom)) {
      collector.error('POL014', `${path}.effectiveFrom`, 'effectiveFrom must be an ISO timestamp');
    }
    if (!isNonEmptyString(policy.summary)) {
      collector.error('POL015', `${path}.summary`, 'policy summary is required');
    }

    const key = `${String(policy.id)}@${String(policy.version)}`;
    if (seen.has(key)) {
      collector.error('POL016', `${path}.version`, `duplicate policy ${key}`);
    }
    seen.add(key);

    if (!Array.isArray(policy.changedRules)) {
      collector.error('POL017', `${path}.changedRules`, 'changedRules must be an array');
    } else {
      policy.changedRules.forEach((change, changeIndex) => {
        validateRuleChange(collector, `${path}.changedRules[${changeIndex}]`, change);
      });
    }

    parsed.push(policy as unknown as AnnotationPolicy);
  });

  const versions = new Set(parsed.map((policy) => policy.version));
  for (const policy of parsed) {
    if (policy.supersedes === null) continue;
    if (!isNonEmptyString(policy.supersedes)) {
      collector.error('POL018', `policies.${policy.version}.supersedes`, 'supersedes must be a version or null');
    } else if (!versions.has(policy.supersedes)) {
      collector.error(
        'POL019',
        `policies.${policy.version}.supersedes`,
        `superseded policy ${policy.supersedes} is not in the registry`,
      );
    } else if (policy.supersedes === policy.version) {
      collector.error('POL026', `policies.${policy.version}.supersedes`, 'a policy may not supersede itself');
    }
  }

  const roots = parsed.filter((policy) => policy.supersedes === null);
  if (roots.length !== 1) {
    collector.error(
      'POL027',
      'policies.policies',
      `exactly one policy must be the root (supersedes: null); found ${roots.length}`,
    );
  }

  return collector.result();
}

export function findPolicy(
  registry: AnnotationPolicyRegistry,
  version: string,
): AnnotationPolicy | null {
  return registry.policies.find((policy) => policy.version === version) ?? null;
}

/**
 * Rule changes introduced by walking from `fromVersion` up to `toVersion`.
 * Returns null when the two are not on the same supersession chain — the caller
 * treats that as "this disagreement cannot be blamed on a policy change".
 */
export function ruleChangesBetween(
  registry: AnnotationPolicyRegistry,
  fromVersion: string,
  toVersion: string,
): readonly PolicyRuleChange[] | null {
  if (fromVersion === toVersion) return [];

  const changes: PolicyRuleChange[] = [];
  let cursor = findPolicy(registry, toVersion);
  const guard = registry.policies.length + 1;

  for (let step = 0; step < guard; step += 1) {
    if (cursor === null) return null;
    changes.push(...cursor.changedRules);
    if (cursor.supersedes === fromVersion) return changes;
    if (cursor.supersedes === null) return null;
    cursor = findPolicy(registry, cursor.supersedes);
  }

  return null;
}

export function policyChangeAffects(
  changes: readonly PolicyRuleChange[],
  dimension: ConsistencyDimension,
): boolean {
  return changes.some((change) => change.affects.includes(dimension));
}
