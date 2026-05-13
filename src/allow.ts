import type { AllowSet, UsageMap } from "./types";
import { INFRA_MEMBERS } from "./constants";
import { toCamelCase } from "./utils";
import { normalizeFileRef } from "./files";

export function buildAllowSet(
  usageMap: UsageMap,
  allow: { include?: string[] } | undefined
): AllowSet {
  const members = new Set<string>(INFRA_MEMBERS);
  const operations = new Set<string>();
  const files = new Set<string>();

  for (const m of usageMap.members ?? []) members.add(toCamelCase(m));
  for (const o of usageMap.operations ?? []) {
    const [member, operation] = o.split(".");
    if (!member || !operation) continue;
    members.add(toCamelCase(member));
    operations.add(`${toCamelCase(member)}.${toCamelCase(operation)}`);
  }
  for (const f of usageMap.files ?? []) {
    files.add(normalizeFileRef(f));
  }

  for (const sym of allow?.include ?? []) {
    if (sym.includes("/")) {
      files.add(normalizeFileRef(sym));
    } else if (sym.includes(".")) {
      const [member, operation] = sym.split(".");
      if (!member || !operation) continue;
      members.add(toCamelCase(member));
      operations.add(`${toCamelCase(member)}.${toCamelCase(operation)}`);
    } else {
      members.add(toCamelCase(sym));
    }
  }

  for (const o of operations) {
    const [member] = o.split(".");
    if (member) members.add(member);
  }

  return { members, operations, files };
}
