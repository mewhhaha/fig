export const I32_MIN = -0x8000_0000;
export const I32_MAX = 0x7fff_ffff;
export const I32_MAX_EXCLUSIVE = 0x8000_0000;

export type DomainEndpoint =
  | { kind: "literal"; value: number; source: string }
  | { kind: "symbol"; name: string };

export interface DomainInterval {
  start: DomainEndpoint;
  end: DomainEndpoint;
}

export interface RefinedI32Domain {
  carrier: "i32";
  intervals: DomainInterval[];
}

export interface I32Range {
  min: number;
  max: number;
}

export type RangeFacts = I32Range;

export interface ScalarFacts {
  carrier: "i32";
  domain: RefinedI32Domain;
  range?: I32Range;
}

export type RefinedScalarDiagnosticCode =
  | "type.scalar_domain_empty"
  | "type.scalar_domain_endpoint"
  | "type.scalar_domain_carrier"
  | "type.scalar_domain_syntax";

export interface RefinedScalarDiagnostic {
  code: RefinedScalarDiagnosticCode;
  message: string;
}

const DOMAIN_CARRIERS = new Set(["i32", "i64", "u32", "u64", "f32", "f64"]);

export function parseRefinedI32Type(type: string | undefined): RefinedI32Domain | undefined {
  const parsed = parseScalarDomainType(type);
  return parsed?.carrier === "i32" ? parsed.domain : undefined;
}

export function refinedI32TypeCanonical(type: string | undefined): string | undefined {
  const domain = parseRefinedI32Type(type);
  return domain ? renderRefinedI32Domain(domain) : undefined;
}

export function scalarDomainRuntimeType(type: string | undefined): string | undefined {
  return parseRefinedI32Type(type) ? "i32" : type?.trim();
}

export function scalarFactsFromRefinedI32Type(type: string | undefined): ScalarFacts | undefined {
  const domain = parseRefinedI32Type(type);
  return domain ? scalarFactsFromDomain(domain) : undefined;
}

export function scalarFactsFromI32Range(range: I32Range): ScalarFacts {
  const min = Math.max(I32_MIN, range.min);
  const max = Math.min(I32_MAX, range.max);
  return scalarFactsFromDomain({
    carrier: "i32",
    intervals: min <= max ? [{ start: literalEndpoint(min), end: literalEndpoint(max + 1) }] : [],
  });
}

export function scalarFactsAnyI32(): ScalarFacts {
  return scalarFactsFromDomain({
    carrier: "i32",
    intervals: [{
      start: literalEndpoint(I32_MIN),
      end: literalEndpoint(I32_MAX_EXCLUSIVE),
    }],
  });
}

export function scalarFactsIntersect(
  left: ScalarFacts,
  right: ScalarFacts,
): ScalarFacts | undefined {
  const intervals = left.domain.intervals.flatMap((leftInterval) =>
    right.domain.intervals
      .map((rightInterval) => intersectIntervals(leftInterval, rightInterval))
      .filter((interval): interval is DomainInterval => interval !== undefined)
  );
  return intervals.length ? scalarFactsFromDomain({ carrier: "i32", intervals }) : undefined;
}

export function scalarFactsIntersectInterval(
  facts: ScalarFacts | undefined,
  interval: DomainInterval,
): ScalarFacts | undefined {
  return scalarFactsIntersect(
    facts ?? scalarFactsAnyI32(),
    scalarFactsFromDomain({ carrier: "i32", intervals: [interval] }),
  );
}

export function scalarFactsContainsLiteral(facts: ScalarFacts, value: number): boolean {
  return domainContainsLiteral(facts.domain, value);
}

export function scalarFactsContainsFacts(expected: ScalarFacts, actual: ScalarFacts): boolean {
  return domainContainsDomain(expected.domain, actual.domain);
}

export function scalarFactsNumericRange(facts: ScalarFacts | undefined): I32Range | undefined {
  return facts?.range;
}

export function scalarFactsAreNonNegative(facts: ScalarFacts | undefined): boolean {
  return (facts?.range?.min ?? I32_MIN) >= 0;
}

export function scalarFactsUnsignedBitWidth(facts: ScalarFacts | undefined): number | undefined {
  const range = facts?.range;
  if (!range || range.min < 0) return undefined;
  return Math.max(1, Math.ceil(Math.log2(range.max + 1)));
}

export function validateScalarDomainType(
  type: string | undefined,
): RefinedScalarDiagnostic | undefined {
  const trimmed = type?.trim();
  if (!trimmed) return undefined;
  const call = scalarDomainCall(trimmed);
  if (!call) return undefined;
  if (!DOMAIN_CARRIERS.has(call.carrier)) return undefined;
  if (call.carrier !== "i32") {
    return {
      code: "type.scalar_domain_carrier",
      message: `scalar domain syntax is only supported for i32 in v1; got ${call.carrier}(...)`,
    };
  }
  const parsed = parseScalarDomainType(trimmed);
  return parsed?.diagnostic;
}

export function refinedI32Assignable(
  expected: string | undefined,
  actual: string | undefined,
): boolean | undefined {
  const expectedFacts = scalarFactsFromRefinedI32Type(expected);
  const actualFacts = scalarFactsFromRefinedI32Type(actual);
  if (!expectedFacts && !actualFacts) return undefined;
  if (!expectedFacts) {
    return expected?.trim() === "i32" && scalarDomainRuntimeType(actual) === "i32"
      ? true
      : undefined;
  }
  if (!actualFacts) return false;
  return scalarFactsContainsFacts(expectedFacts, actualFacts);
}

export function refinedI32ContainsLiteral(
  type: string | undefined,
  value: number,
): boolean {
  const facts = scalarFactsFromRefinedI32Type(type);
  return facts ? scalarFactsContainsLiteral(facts, value) : false;
}

export function refinedI32NumericRange(type: string | undefined): I32Range | undefined {
  return scalarFactsFromRefinedI32Type(type)?.range;
}

export function refinedI32FromRange(min: DomainEndpoint, maxExclusive: DomainEndpoint): string {
  return renderRefinedI32Domain({
    carrier: "i32",
    intervals: normalizeIntervals([{ start: min, end: maxExclusive }]),
  });
}

export function literalEndpoint(value: number): DomainEndpoint {
  return { kind: "literal", value, source: String(value) };
}

export function endpointFromTypeExprText(source: string): DomainEndpoint | undefined {
  return parseEndpoint(source);
}

export function intervalFromRefinedType(type: string | undefined): DomainInterval[] | undefined {
  return parseRefinedI32Type(type)?.intervals;
}

export function intersectRefinedI32Type(
  type: string | undefined,
  constraint: DomainInterval,
): string | undefined {
  const facts = scalarFactsIntersectInterval(scalarFactsFromRefinedI32Type(type), constraint);
  return facts ? renderRefinedI32Domain(facts.domain) : undefined;
}

function parseScalarDomainType(
  type: string | undefined,
): { carrier: string; domain: RefinedI32Domain; diagnostic?: RefinedScalarDiagnostic } | undefined {
  const call = scalarDomainCall(type?.trim() ?? "");
  if (!call) return undefined;
  const members = splitDomainUnion(call.body);
  if (!members.length) {
    return {
      carrier: call.carrier,
      domain: { carrier: "i32", intervals: [] },
      diagnostic: {
        code: "type.scalar_domain_syntax",
        message: "scalar domain requires at least one member",
      },
    };
  }
  const intervals: DomainInterval[] = [];
  for (const member of members) {
    const interval = parseDomainMember(member);
    if (!interval) {
      return {
        carrier: call.carrier,
        domain: { carrier: "i32", intervals: [] },
        diagnostic: {
          code: "type.scalar_domain_endpoint",
          message: `invalid scalar domain member ${member}`,
        },
      };
    }
    if (
      interval.start.kind === "literal" && interval.end.kind === "literal" &&
      interval.start.value >= interval.end.value
    ) {
      return {
        carrier: call.carrier,
        domain: { carrier: "i32", intervals: [] },
        diagnostic: {
          code: "type.scalar_domain_empty",
          message: `scalar domain range ${member} is empty`,
        },
      };
    }
    intervals.push(interval);
  }
  return {
    carrier: call.carrier,
    domain: { carrier: "i32", intervals: normalizeIntervals(intervals) },
  };
}

function scalarFactsFromDomain(domain: RefinedI32Domain): ScalarFacts {
  const normalized = {
    carrier: "i32" as const,
    intervals: normalizeIntervals(domain.intervals),
  };
  const range = domainNumericRange(normalized);
  return range
    ? { carrier: "i32", domain: normalized, range }
    : { carrier: "i32", domain: normalized };
}

function domainNumericRange(domain: RefinedI32Domain): I32Range | undefined {
  if (!domain.intervals.length) return undefined;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const interval of domain.intervals) {
    if (interval.start.kind !== "literal" || interval.end.kind !== "literal") return undefined;
    min = Math.min(min, interval.start.value);
    max = Math.max(max, interval.end.value - 1);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return undefined;
  return {
    min: Math.max(I32_MIN, min),
    max: Math.min(I32_MAX, max),
  };
}

function scalarDomainCall(type: string): { carrier: string; body: string } | undefined {
  const match = type.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)$/);
  if (!match) return undefined;
  return { carrier: match[1], body: match[2].trim() };
}

function splitDomainUnion(source: string): string[] {
  return source.split("|").map((part) => part.trim()).filter(Boolean);
}

function parseDomainMember(source: string): DomainInterval | undefined {
  const range = source.match(/^([\s\S]+?)\s*\.\.\s*([\s\S]+)$/);
  if (range) {
    const start = parseEndpoint(range[1].trim());
    const end = parseEndpoint(range[2].trim());
    return start && end ? { start, end } : undefined;
  }
  const start = parseEndpoint(source.trim());
  if (!start) return undefined;
  if (start.kind !== "literal") return undefined;
  return { start, end: literalEndpoint(start.value + 1) };
}

function parseEndpoint(source: string): DomainEndpoint | undefined {
  if (/^-?[0-9]+$/.test(source)) {
    const value = Number.parseInt(source, 10);
    if (!Number.isSafeInteger(value)) return undefined;
    return { kind: "literal", value, source };
  }
  if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(source)) return { kind: "symbol", name: source };
  return undefined;
}

function normalizeIntervals(intervals: DomainInterval[]): DomainInterval[] {
  const byKey = new Map<string, DomainInterval>();
  for (const interval of intervals) byKey.set(renderInterval(interval), interval);
  return [...byKey.values()].toSorted(compareIntervals);
}

function compareIntervals(left: DomainInterval, right: DomainInterval): number {
  const leftStart = endpointSortKey(left.start);
  const rightStart = endpointSortKey(right.start);
  if (leftStart !== rightStart) return leftStart < rightStart ? -1 : 1;
  const leftEnd = endpointSortKey(left.end);
  const rightEnd = endpointSortKey(right.end);
  return leftEnd === rightEnd ? 0 : leftEnd < rightEnd ? -1 : 1;
}

function endpointSortKey(endpoint: DomainEndpoint): string {
  return endpoint.kind === "literal"
    ? `0:${String(endpoint.value).padStart(12, "0")}`
    : `1:${endpoint.name}`;
}

function renderRefinedI32Domain(domain: RefinedI32Domain): string {
  return `i32(${domain.intervals.map(renderInterval).join(" | ")})`;
}

function renderInterval(interval: DomainInterval): string {
  if (
    interval.start.kind === "literal" && interval.end.kind === "literal" &&
    interval.end.value === interval.start.value + 1
  ) return renderEndpoint(interval.start);
  if (sameEndpoint(interval.start, interval.end)) return renderEndpoint(interval.start);
  return `${renderEndpoint(interval.start)}..${renderEndpoint(interval.end)}`;
}

function renderEndpoint(endpoint: DomainEndpoint): string {
  return endpoint.kind === "literal" ? endpoint.source : endpoint.name;
}

function domainContainsLiteral(domain: RefinedI32Domain, value: number): boolean {
  return domain.intervals.some((interval) =>
    endpointLeq(interval.start, literalEndpoint(value)) &&
    endpointLt(literalEndpoint(value), interval.end)
  );
}

function domainContainsDomain(expected: RefinedI32Domain, actual: RefinedI32Domain): boolean {
  return actual.intervals.every((actualInterval) =>
    expected.intervals.some((expectedInterval) =>
      endpointLeq(expectedInterval.start, actualInterval.start) &&
      endpointLeq(actualInterval.end, expectedInterval.end)
    )
  );
}

function intersectIntervals(
  left: DomainInterval,
  right: DomainInterval,
): DomainInterval | undefined {
  const start = endpointMax(left.start, right.start);
  const end = endpointMin(left.end, right.end);
  if (!start || !end) return undefined;
  if (endpointLt(start, end)) return { start, end };
  if (sameEndpoint(start, end)) return undefined;
  if (start.kind !== "literal" || end.kind !== "literal") return { start, end };
  return undefined;
}

function endpointMin(left: DomainEndpoint, right: DomainEndpoint): DomainEndpoint | undefined {
  if (left.kind === "literal" && left.value === I32_MAX_EXCLUSIVE) return right;
  if (right.kind === "literal" && right.value === I32_MAX_EXCLUSIVE) return left;
  if (endpointLeq(left, right)) return left;
  if (endpointLeq(right, left)) return right;
  return sameEndpoint(left, right) ? left : undefined;
}

function endpointMax(left: DomainEndpoint, right: DomainEndpoint): DomainEndpoint | undefined {
  if (left.kind === "literal" && left.value === I32_MIN) return right;
  if (right.kind === "literal" && right.value === I32_MIN) return left;
  if (endpointLeq(left, right)) return right;
  if (endpointLeq(right, left)) return left;
  return sameEndpoint(left, right) ? left : undefined;
}

function endpointLt(left: DomainEndpoint, right: DomainEndpoint): boolean {
  if (left.kind === "literal" && right.kind === "literal") return left.value < right.value;
  return false;
}

function endpointLeq(left: DomainEndpoint, right: DomainEndpoint): boolean {
  if (sameEndpoint(left, right)) return true;
  if (left.kind === "literal" && right.kind === "literal") return left.value <= right.value;
  return false;
}

function sameEndpoint(left: DomainEndpoint, right: DomainEndpoint): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "literal" && right.kind === "literal") return left.value === right.value;
  if (left.kind === "symbol" && right.kind === "symbol") return left.name === right.name;
  return false;
}
