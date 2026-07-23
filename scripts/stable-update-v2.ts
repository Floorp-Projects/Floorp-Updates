import { basename, dirname, join, resolve } from "node:path";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SHA512_PATTERN = /^[0-9a-f]{128}$/;
const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const BUILD_ID_PATTERN = /^\d{14}$/;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIREFOX_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?$/;
const DETAILS_URL = "https://blog.floorp.app/categories/release/";

export const TARGET_DEFINITIONS = [
  {
    key: "windows",
    platform: "WINNT",
    metadataArch: "x86_64",
    assetName: "floorp-windows-x86_64-full.mar",
    metaName: "win-meta.json",
    endpoints: [["WINNT", "x86_64"]] as const,
  },
  {
    key: "linux",
    platform: "Linux",
    metadataArch: "x86_64",
    assetName: "floorp-linux-x86_64-full.mar",
    metaName: "linux-meta.json",
    endpoints: [["Linux", "x86_64"]] as const,
  },
  {
    key: "linuxAarch64",
    platform: "Linux",
    metadataArch: "aarch64",
    assetName: "floorp-linux-aarch64-full.mar",
    metaName: "linux-aarch64-meta.json",
    endpoints: [["Linux", "aarch64"]] as const,
  },
  {
    key: "mac",
    platform: "Darwin",
    metadataArch: "universal",
    assetName: "floorp-mac-universal-full.mar",
    metaName: "mac-meta.json",
    endpoints: [["Darwin", "x86_64"], ["Darwin", "aarch64"]] as const,
  },
] as const;

export type TargetKey = (typeof TARGET_DEFINITIONS)[number]["key"];

export interface ArtifactInput {
  metaPath: string;
  marPath: string;
  marUrl: string;
}

export interface StableUpdateInput {
  firefoxVersion: string;
  appVersion2: string;
  artifacts: Record<TargetKey, ArtifactInput>;
  statePath: string;
  outputRoot: string;
}

interface MarMetadata {
  url: string;
  name: string;
  size: number;
  sha512: string;
}

interface ProvenanceMetadata {
  runtime_repository: string;
  runtime_head_sha: string;
  runtime_run_id: number;
  runtime_artifact_id: number;
  runtime_artifact_digest: string;
  floorp_repository: string;
  floorp_head_sha: string;
  floorp_run_id: number;
  release_tag: string;
}

interface VerificationMetadata {
  status: string;
  method: string;
  app_build_id: string;
  build_id2: string;
}

export interface ValidatedMetadata {
  schema_version: 2;
  version_display: string;
  version: string;
  noraneko_version: string;
  buildid: string;
  noraneko_buildid: string;
  channel: "release";
  platform: "WINNT" | "Linux" | "Darwin";
  arch: "x86_64" | "aarch64" | "universal";
  manifest_set_id: string;
  mar: MarMetadata;
  provenance: ProvenanceMetadata;
  verification: VerificationMetadata;
  metadata_sha256: string;
}

export interface ValidatedManifestSet {
  firefoxVersion: string;
  appVersion2: string;
  manifestSetId: string;
  floorpHeadSha: string;
  floorpRunId: number;
  releaseTag: string;
  metadata: Record<TargetKey, ValidatedMetadata>;
}

interface LegacyTargetState {
  buildid: string;
  buildid2: string;
  url: string;
  size: number;
}

export interface LegacyState {
  schema_version: 1;
  status: "legacy-bootstrap";
  version: string;
  app_version2: string;
  baseline_commit: string;
  targets: Record<string, LegacyTargetState>;
}

interface VerifiedTargetState extends LegacyTargetState {
  platform: string;
  arch: string;
  metadata_arch: string;
  name: string;
  sha512: string;
  metadata_sha256: string;
}

export interface VerifiedState {
  schema_version: 1;
  status: "verified";
  manifest_set_id: string;
  version: string;
  app_version2: string;
  floorp_head_sha: string;
  floorp_run_id: number;
  targets: Record<string, VerifiedTargetState>;
}

export type StableState = LegacyState | VerifiedState;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function fail(message: string): never {
  throw new ValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${path} must be an object`);
  return value;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const result = value[key];
  if (typeof result !== "string" || result.length === 0) {
    fail(`${path}.${key} must be a non-empty string`);
  }
  return result;
}

function positiveIntegerField(
  value: Record<string, unknown>,
  key: string,
  path: string,
): number {
  const result = value[key];
  if (!Number.isSafeInteger(result) || (result as number) <= 0) {
    fail(`${path}.${key} must be a positive safe integer`);
  }
  return result as number;
}

function expectEqual(actual: unknown, expected: unknown, path: string): void {
  if (actual !== expected) {
    fail(
      `${path} must equal ${JSON.stringify(expected)}; got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function expectPattern(value: string, pattern: RegExp, path: string): void {
  if (!pattern.test(value)) fail(`${path} has an invalid format`);
}

function validateBuildId(value: string, path: string): void {
  expectPattern(value, BUILD_ID_PATTERN, path);
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const roundTrip = [
    date.getUTCFullYear().toString().padStart(4, "0"),
    (date.getUTCMonth() + 1).toString().padStart(2, "0"),
    date.getUTCDate().toString().padStart(2, "0"),
    date.getUTCHours().toString().padStart(2, "0"),
    date.getUTCMinutes().toString().padStart(2, "0"),
    date.getUTCSeconds().toString().padStart(2, "0"),
  ].join("");
  if (roundTrip !== value) fail(`${path} is not a valid UTC timestamp`);
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseSemVer(value: string, path: string): SemVer {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
      .exec(
        value,
      );
  if (!match) fail(`${path} must be a valid semantic version`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

export function compareSemVer(left: string, right: string): number {
  const a = parseSemVer(left, "left version");
  const b = parseSemVer(right, "right version");
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) return Number(av) < Number(bv) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

export function compareFirefoxVersion(left: string, right: string): number {
  expectPattern(left, FIREFOX_VERSION_PATTERN, "left Firefox version");
  expectPattern(right, FIREFOX_VERSION_PATTERN, "right Firefox version");
  const a = left.split(".").map((part) => BigInt(part));
  const b = right.split(".").map((part) => BigInt(part));
  for (let index = 0; index < 3; index++) {
    const av = a[index] ?? 0n;
    const bv = b[index] ?? 0n;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(
    new Uint8Array(bytes),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function digestBytes(
  algorithm: "SHA-256" | "SHA-512",
  bytes: Uint8Array,
): Promise<string> {
  return bytesToHex(
    await crypto.subtle.digest(algorithm, bytes as Uint8Array<ArrayBuffer>),
  );
}

export function canonicalReleaseUrl(
  appVersion2: string,
  assetName: string,
): string {
  return `https://github.com/Floorp-Projects/Floorp/releases/download/v${appVersion2}/${assetName}`;
}

async function validateOneMetadata(
  definition: (typeof TARGET_DEFINITIONS)[number],
  input: ArtifactInput,
  firefoxVersion: string,
  appVersion2: string,
): Promise<ValidatedMetadata> {
  const path = definition.key;
  const expectedUrl = canonicalReleaseUrl(appVersion2, definition.assetName);
  expectEqual(input.marUrl, expectedUrl, `${path} dispatch MAR URL`);

  let bytes: Uint8Array;
  let parsed: unknown;
  try {
    bytes = await Deno.readFile(input.metaPath);
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    fail(
      `${path} metadata cannot be read as JSON: ${(error as Error).message}`,
    );
  }
  const root = record(parsed, path);
  expectEqual(root.schema_version, 2, `${path}.schema_version`);
  const versionDisplay = stringField(root, "version_display", path);
  expectEqual(
    versionDisplay,
    `${appVersion2}@${firefoxVersion}`,
    `${path}.version_display`,
  );
  const version = stringField(root, "version", path);
  expectEqual(version, firefoxVersion, `${path}.version`);
  const noranekoVersion = stringField(root, "noraneko_version", path);
  expectEqual(noranekoVersion, appVersion2, `${path}.noraneko_version`);
  const buildid = stringField(root, "buildid", path);
  validateBuildId(buildid, `${path}.buildid`);
  const buildid2 = stringField(root, "noraneko_buildid", path);
  expectPattern(buildid2, UUID_V7_PATTERN, `${path}.noraneko_buildid`);
  expectEqual(root.channel, "release", `${path}.channel`);
  expectEqual(root.platform, definition.platform, `${path}.platform`);
  expectEqual(root.arch, definition.metadataArch, `${path}.arch`);
  const manifestSetId = stringField(root, "manifest_set_id", path);
  expectPattern(manifestSetId, SHA256_PATTERN, `${path}.manifest_set_id`);

  const marRoot = record(root.mar, `${path}.mar`);
  const marUrl = stringField(marRoot, "url", `${path}.mar`);
  expectEqual(marUrl, input.marUrl, `${path}.mar.url`);
  const marName = stringField(marRoot, "name", `${path}.mar`);
  expectEqual(marName, definition.assetName, `${path}.mar.name`);
  const marSize = positiveIntegerField(marRoot, "size", `${path}.mar`);
  const marSha512 = stringField(marRoot, "sha512", `${path}.mar`);
  expectPattern(marSha512, SHA512_PATTERN, `${path}.mar.sha512`);

  let marBytes: Uint8Array;
  let marStat: Deno.FileInfo;
  try {
    marStat = await Deno.stat(input.marPath);
    if (!marStat.isFile) fail(`${path} MAR path is not a file`);
    marBytes = await Deno.readFile(input.marPath);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    fail(`${path} MAR cannot be read: ${(error as Error).message}`);
  }
  expectEqual(marStat.size, marSize, `${path}.mar.size versus downloaded MAR`);
  const actualSha512 = await digestBytes("SHA-512", marBytes);
  expectEqual(
    actualSha512,
    marSha512,
    `${path}.mar.sha512 versus downloaded MAR`,
  );

  const provenanceRoot = record(root.provenance, `${path}.provenance`);
  const runtimeRepository = stringField(
    provenanceRoot,
    "runtime_repository",
    `${path}.provenance`,
  );
  expectEqual(
    runtimeRepository,
    "Floorp-Projects/Floorp-Runtime",
    `${path}.provenance.runtime_repository`,
  );
  const runtimeHeadSha = stringField(
    provenanceRoot,
    "runtime_head_sha",
    `${path}.provenance`,
  );
  expectPattern(
    runtimeHeadSha,
    SHA1_PATTERN,
    `${path}.provenance.runtime_head_sha`,
  );
  const runtimeRunId = positiveIntegerField(
    provenanceRoot,
    "runtime_run_id",
    `${path}.provenance`,
  );
  const runtimeArtifactId = positiveIntegerField(
    provenanceRoot,
    "runtime_artifact_id",
    `${path}.provenance`,
  );
  const runtimeArtifactDigest = stringField(
    provenanceRoot,
    "runtime_artifact_digest",
    `${path}.provenance`,
  );
  expectPattern(
    runtimeArtifactDigest,
    SHA256_PATTERN,
    `${path}.provenance.runtime_artifact_digest`,
  );
  const floorpRepository = stringField(
    provenanceRoot,
    "floorp_repository",
    `${path}.provenance`,
  );
  expectEqual(
    floorpRepository,
    "Floorp-Projects/Floorp",
    `${path}.provenance.floorp_repository`,
  );
  const floorpHeadSha = stringField(
    provenanceRoot,
    "floorp_head_sha",
    `${path}.provenance`,
  );
  expectPattern(
    floorpHeadSha,
    SHA1_PATTERN,
    `${path}.provenance.floorp_head_sha`,
  );
  const floorpRunId = positiveIntegerField(
    provenanceRoot,
    "floorp_run_id",
    `${path}.provenance`,
  );
  const releaseTag = stringField(
    provenanceRoot,
    "release_tag",
    `${path}.provenance`,
  );
  expectEqual(releaseTag, `v${appVersion2}`, `${path}.provenance.release_tag`);

  const verificationRoot = record(root.verification, `${path}.verification`);
  expectEqual(
    verificationRoot.status,
    "verified",
    `${path}.verification.status`,
  );
  expectEqual(
    verificationRoot.method,
    "full-version",
    `${path}.verification.method`,
  );
  const appBuildId = stringField(
    verificationRoot,
    "app_build_id",
    `${path}.verification`,
  );
  expectEqual(appBuildId, buildid, `${path}.verification.app_build_id`);
  const verificationBuildId2 = stringField(
    verificationRoot,
    "build_id2",
    `${path}.verification`,
  );
  expectEqual(
    verificationBuildId2,
    buildid2,
    `${path}.verification.build_id2`,
  );

  return {
    schema_version: 2,
    version_display: versionDisplay,
    version,
    noraneko_version: noranekoVersion,
    buildid,
    noraneko_buildid: buildid2,
    channel: "release",
    platform: definition.platform,
    arch: definition.metadataArch,
    manifest_set_id: manifestSetId,
    mar: { url: marUrl, name: marName, size: marSize, sha512: marSha512 },
    provenance: {
      runtime_repository: runtimeRepository,
      runtime_head_sha: runtimeHeadSha,
      runtime_run_id: runtimeRunId,
      runtime_artifact_id: runtimeArtifactId,
      runtime_artifact_digest: runtimeArtifactDigest,
      floorp_repository: floorpRepository,
      floorp_head_sha: floorpHeadSha,
      floorp_run_id: floorpRunId,
      release_tag: releaseTag,
    },
    verification: {
      status: "verified",
      method: "full-version",
      app_build_id: appBuildId,
      build_id2: verificationBuildId2,
    },
    metadata_sha256: `sha256:${await digestBytes("SHA-256", bytes!)}`,
  };
}

export async function validateManifestSet(
  input: Pick<
    StableUpdateInput,
    "firefoxVersion" | "appVersion2" | "artifacts"
  >,
): Promise<ValidatedManifestSet> {
  expectPattern(
    input.firefoxVersion,
    FIREFOX_VERSION_PATTERN,
    "firefox-version",
  );
  parseSemVer(input.appVersion2, "app-version2");

  const metadata = {} as Record<TargetKey, ValidatedMetadata>;
  for (const definition of TARGET_DEFINITIONS) {
    metadata[definition.key] = await validateOneMetadata(
      definition,
      input.artifacts[definition.key],
      input.firefoxVersion,
      input.appVersion2,
    );
  }
  const first = metadata.windows;
  for (const definition of TARGET_DEFINITIONS.slice(1)) {
    const value = metadata[definition.key];
    for (
      const key of ["version", "noraneko_version", "manifest_set_id"] as const
    ) {
      expectEqual(
        value[key],
        first[key],
        `${definition.key}.${key} across manifest set`,
      );
    }
    for (
      const key of ["floorp_head_sha", "floorp_run_id", "release_tag"] as const
    ) {
      expectEqual(
        value.provenance[key],
        first.provenance[key],
        `${definition.key}.provenance.${key} across manifest set`,
      );
    }
    for (
      const key of [
        "runtime_repository",
        "runtime_head_sha",
        "runtime_run_id",
      ] as const
    ) {
      expectEqual(
        value.provenance[key],
        first.provenance[key],
        `${definition.key}.provenance.${key} across manifest set`,
      );
    }
  }

  const recomputedManifestSetId = await computeManifestSetId(metadata);
  for (const definition of TARGET_DEFINITIONS) {
    expectEqual(
      metadata[definition.key].manifest_set_id,
      recomputedManifestSetId,
      `${definition.key}.manifest_set_id versus canonical manifest set`,
    );
  }

  return {
    firefoxVersion: input.firefoxVersion,
    appVersion2: input.appVersion2,
    manifestSetId: first.manifest_set_id,
    floorpHeadSha: first.provenance.floorp_head_sha,
    floorpRunId: first.provenance.floorp_run_id,
    releaseTag: first.provenance.release_tag,
    metadata,
  };
}

export function buildManifestSetIdentity(
  metadata: Record<TargetKey, ValidatedMetadata>,
): Record<string, unknown> {
  const first = metadata.windows;
  return {
    schema_version: 2,
    floorp: {
      repository: first.provenance.floorp_repository,
      head_sha: first.provenance.floorp_head_sha,
      run_id: first.provenance.floorp_run_id,
      release_tag: first.provenance.release_tag,
    },
    targets: TARGET_DEFINITIONS.map((definition) => {
      const value = metadata[definition.key];
      return {
        platform: value.platform,
        arch: value.arch,
        mar: {
          name: value.mar.name,
          size: value.mar.size,
          sha512: value.mar.sha512,
        },
        runtime: {
          repository: value.provenance.runtime_repository,
          head_sha: value.provenance.runtime_head_sha,
          run_id: value.provenance.runtime_run_id,
          artifact_id: value.provenance.runtime_artifact_id,
          artifact_digest: value.provenance.runtime_artifact_digest,
        },
        verification: {
          app_build_id: value.verification.app_build_id,
          build_id2: value.verification.build_id2,
        },
      };
    }),
  };
}

export async function computeManifestSetId(
  metadata: Record<TargetKey, ValidatedMetadata>,
): Promise<string> {
  const identity = buildManifestSetIdentity(metadata);
  return `sha256:${await digestBytes(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(identity)),
  )}`;
}

const ENDPOINT_KEYS = TARGET_DEFINITIONS.flatMap((definition) =>
  definition.endpoints.map(([platform, arch]) =>
    `browser/stable/${platform}/${arch}/update.xml`
  )
);

function validateState(value: unknown): StableState {
  const root = record(value, "stable state");
  expectEqual(root.schema_version, 1, "stable state.schema_version");
  const status = stringField(root, "status", "stable state");
  const version = stringField(root, "version", "stable state");
  expectPattern(version, FIREFOX_VERSION_PATTERN, "stable state.version");
  const appVersion2 = stringField(root, "app_version2", "stable state");
  parseSemVer(appVersion2, "stable state.app_version2");
  const targets = record(root.targets, "stable state.targets");
  const targetKeys = Object.keys(targets).sort();
  expectEqual(
    JSON.stringify(targetKeys),
    JSON.stringify([...ENDPOINT_KEYS].sort()),
    "stable state target keys",
  );

  if (status === "legacy-bootstrap") {
    const baselineCommit = stringField(root, "baseline_commit", "stable state");
    expectPattern(baselineCommit, SHA1_PATTERN, "stable state.baseline_commit");
    for (const key of ENDPOINT_KEYS) {
      const target = record(targets[key], `stable state.targets.${key}`);
      validateBuildId(
        stringField(target, "buildid", `stable state.targets.${key}`),
        `stable state.targets.${key}.buildid`,
      );
      expectPattern(
        stringField(target, "buildid2", `stable state.targets.${key}`),
        UUID_V7_PATTERN,
        `stable state.targets.${key}.buildid2`,
      );
      stringField(target, "url", `stable state.targets.${key}`);
      positiveIntegerField(target, "size", `stable state.targets.${key}`);
    }
    return root as unknown as LegacyState;
  }

  if (status === "verified") {
    expectPattern(
      stringField(root, "manifest_set_id", "stable state"),
      SHA256_PATTERN,
      "stable state.manifest_set_id",
    );
    expectPattern(
      stringField(root, "floorp_head_sha", "stable state"),
      SHA1_PATTERN,
      "stable state.floorp_head_sha",
    );
    positiveIntegerField(root, "floorp_run_id", "stable state");
    for (const key of ENDPOINT_KEYS) {
      const target = record(targets[key], `stable state.targets.${key}`);
      validateBuildId(
        stringField(target, "buildid", `stable state.targets.${key}`),
        `stable state.targets.${key}.buildid`,
      );
      expectPattern(
        stringField(target, "buildid2", `stable state.targets.${key}`),
        UUID_V7_PATTERN,
        `stable state.targets.${key}.buildid2`,
      );
      for (
        const name of [
          "platform",
          "arch",
          "metadata_arch",
          "url",
          "name",
        ] as const
      ) {
        stringField(target, name, `stable state.targets.${key}`);
      }
      positiveIntegerField(target, "size", `stable state.targets.${key}`);
      expectPattern(
        stringField(target, "sha512", `stable state.targets.${key}`),
        SHA512_PATTERN,
        `stable state.targets.${key}.sha512`,
      );
      expectPattern(
        stringField(target, "metadata_sha256", `stable state.targets.${key}`),
        SHA256_PATTERN,
        `stable state.targets.${key}.metadata_sha256`,
      );
    }
    return root as unknown as VerifiedState;
  }

  fail(`stable state.status must be "legacy-bootstrap" or "verified"`);
}

export function buildVerifiedState(
  manifest: ValidatedManifestSet,
): VerifiedState {
  const targets: Record<string, VerifiedTargetState> = {};
  for (const definition of TARGET_DEFINITIONS) {
    const metadata = manifest.metadata[definition.key];
    for (const [platform, arch] of definition.endpoints) {
      targets[`browser/stable/${platform}/${arch}/update.xml`] = {
        platform,
        arch,
        metadata_arch: metadata.arch,
        buildid: metadata.buildid,
        buildid2: metadata.noraneko_buildid,
        url: metadata.mar.url,
        name: metadata.mar.name,
        size: metadata.mar.size,
        sha512: metadata.mar.sha512,
        metadata_sha256: metadata.metadata_sha256,
      };
    }
  }
  return {
    schema_version: 1,
    status: "verified",
    manifest_set_id: manifest.manifestSetId,
    version: manifest.firefoxVersion,
    app_version2: manifest.appVersion2,
    floorp_head_sha: manifest.floorpHeadSha,
    floorp_run_id: manifest.floorpRunId,
    targets,
  };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${
      Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(value[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

export function determineTransition(
  current: StableState,
  next: VerifiedState,
): "update" | "noop" {
  if (compareFirefoxVersion(next.version, current.version) < 0) {
    fail(
      `new manifest must not downgrade Firefox version from ${current.version} to ${next.version}`,
    );
  }

  if (current.status === "legacy-bootstrap") {
    if (compareSemVer(next.app_version2, current.app_version2) <= 0) {
      fail(
        `legacy bootstrap only accepts a newer app version than ${current.app_version2}; got ${next.app_version2}`,
      );
    }
    return "update";
  }

  if (current.manifest_set_id === next.manifest_set_id) {
    if (canonicalJson(current) !== canonicalJson(next)) {
      fail("manifest_set_id was reused with different verified state content");
    }
    return "noop";
  }

  if (compareSemVer(next.app_version2, current.app_version2) <= 0) {
    fail(
      `new manifest must have a newer app version than ${current.app_version2}; got ${next.app_version2}`,
    );
  }
  return "update";
}

function renderUpdateXml(
  metadata: ValidatedMetadata,
  manifest: ValidatedManifestSet,
): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<updates>",
    `    <update type="minor" displayVersion="${manifest.firefoxVersion}@${manifest.appVersion2}" appVersion="${manifest.firefoxVersion}" platformVersion="${manifest.firefoxVersion}" buildID="${metadata.buildid}" appVersion2="${manifest.appVersion2}" buildID2="${metadata.noraneko_buildid}" detailsURL="${DETAILS_URL}">`,
    `        <patch type="complete" URL="${metadata.mar.url}" hashFunction="sha512" hashValue="${metadata.mar.sha512}" size="${metadata.mar.size}"/>`,
    "    </update>",
    "</updates>",
    "",
  ].join("\n");
}

interface PendingReplacement {
  temporary: string;
  destination: string;
}

async function publishAtomically(
  outputRoot: string,
  statePath: string,
  manifest: ValidatedManifestSet,
  state: VerifiedState,
): Promise<void> {
  const root = resolve(outputRoot);
  const stateDestination = resolve(statePath);
  if (stateDestination !== join(root, "stable-state.json")) {
    fail("state-file must be stable-state.json directly under output-root");
  }
  await Deno.mkdir(dirname(root), { recursive: true });
  const stageRoot = await Deno.makeTempDir({
    dir: dirname(root),
    prefix: ".stable-update-v2-stage-",
  });
  const replacements: PendingReplacement[] = [];
  try {
    for (const definition of TARGET_DEFINITIONS) {
      const xml = renderUpdateXml(manifest.metadata[definition.key], manifest);
      for (const [platform, arch] of definition.endpoints) {
        const staged = join(stageRoot, platform, arch, "update.xml");
        await Deno.mkdir(dirname(staged), { recursive: true });
        await Deno.writeTextFile(staged, xml);
      }
    }
    const stagedState = join(stageRoot, "stable-state.json");
    await Deno.writeTextFile(
      stagedState,
      `${JSON.stringify(state, null, 2)}\n`,
    );

    const stagedFiles = TARGET_DEFINITIONS.flatMap((definition) =>
      definition.endpoints.map(([platform, arch]) => ({
        staged: join(stageRoot, platform, arch, "update.xml"),
        destination: join(root, platform, arch, "update.xml"),
      }))
    );
    stagedFiles.push({ staged: stagedState, destination: stateDestination });

    for (const file of stagedFiles) {
      await Deno.mkdir(dirname(file.destination), { recursive: true });
      const temporary = join(
        dirname(file.destination),
        `.${basename(file.destination)}.${crypto.randomUUID()}.tmp`,
      );
      await Deno.copyFile(file.staged, temporary);
      replacements.push({ temporary, destination: file.destination });
    }
    for (const replacement of replacements) {
      await Deno.rename(replacement.temporary, replacement.destination);
    }
  } finally {
    for (const replacement of replacements) {
      try {
        await Deno.remove(replacement.temporary);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          console.warn(
            `Could not remove temporary replacement ${replacement.temporary}: ${error}`,
          );
        }
      }
    }
    await Deno.remove(stageRoot, { recursive: true });
  }
}

export async function applyStableUpdate(
  input: StableUpdateInput,
): Promise<"updated" | "noop"> {
  const manifest = await validateManifestSet(input);
  let stateJson: unknown;
  try {
    stateJson = JSON.parse(await Deno.readTextFile(input.statePath));
  } catch (error) {
    fail(`stable state cannot be read as JSON: ${(error as Error).message}`);
  }
  const current = validateState(stateJson);
  const next = buildVerifiedState(manifest);
  const transition = determineTransition(current, next);
  if (transition === "noop") return "noop";
  await publishAtomically(input.outputRoot, input.statePath, manifest, next);
  return "updated";
}

function parseFlags(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      fail(
        `arguments must be --name value pairs; got ${flag ?? "end of input"}`,
      );
    }
    const name = flag.slice(2);
    if (name in result) fail(`duplicate argument --${name}`);
    result[name] = value;
  }
  return result;
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value) fail(`missing required argument --${name}`);
  return value;
}

async function main(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const allowed = new Set([
    "firefox-version",
    "app-version2",
    "state-file",
    "output-root",
    ...TARGET_DEFINITIONS.flatMap((definition) => [
      `${definition.key}-meta`,
      `${definition.key}-mar`,
      `${definition.key}-mar-url`,
    ]),
  ]);
  for (const name of Object.keys(flags)) {
    if (!allowed.has(name)) fail(`unknown argument --${name}`);
  }
  const artifacts = Object.fromEntries(
    TARGET_DEFINITIONS.map((definition) => [definition.key, {
      metaPath: requireFlag(flags, `${definition.key}-meta`),
      marPath: requireFlag(flags, `${definition.key}-mar`),
      marUrl: requireFlag(flags, `${definition.key}-mar-url`),
    }]),
  ) as Record<TargetKey, ArtifactInput>;
  const result = await applyStableUpdate({
    firefoxVersion: requireFlag(flags, "firefox-version"),
    appVersion2: requireFlag(flags, "app-version2"),
    statePath: requireFlag(flags, "state-file"),
    outputRoot: requireFlag(flags, "output-root"),
    artifacts,
  });
  console.log(JSON.stringify({ result }));
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
