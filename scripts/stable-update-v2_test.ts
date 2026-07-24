import {
  applyStableUpdate,
  buildVerifiedState,
  canonicalReleaseUrl,
  compareFirefoxVersion,
  compareSemVer,
  computeManifestSetId,
  determineTransition,
  type LegacyState,
  type StableUpdateInput,
  TARGET_DEFINITIONS,
  type TargetKey,
  type ValidatedMetadata,
  validateManifestSet,
  type VerifiedState,
} from "./stable-update-v2.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message?: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ??
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function assertRejects(
  action: () => Promise<unknown> | unknown,
  expectedMessage: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(
      message.includes(expectedMessage),
      `expected error containing ${JSON.stringify(expectedMessage)}, got ${
        JSON.stringify(message)
      }`,
    );
    return;
  }
  throw new Error(
    `expected rejection containing ${JSON.stringify(expectedMessage)}`,
  );
}

function nested(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const result = value[key];
  assert(
    typeof result === "object" && result !== null && !Array.isArray(result),
    `${key} must be an object in test fixture`,
  );
  return result as Record<string, unknown>;
}

async function hexDigest(
  algorithm: "SHA-256" | "SHA-512",
  bytes: Uint8Array,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    algorithm,
    bytes as Uint8Array<ArrayBuffer>,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

interface Fixture {
  root: string;
  input: StableUpdateInput;
  metas: Record<TargetKey, Record<string, unknown>>;
}

const BUILD_IDS: Record<TargetKey, string> = {
  windows: "20260722010101",
  linux: "20260722010202",
  linuxAarch64: "20260722010303",
  mac: "20260722010404",
};

const BUILD_IDS_2: Record<TargetKey, string> = {
  windows: "019f9000-0000-7000-8000-000000000001",
  linux: "019f9000-0000-7000-8000-000000000002",
  linuxAarch64: "019f9000-0000-7000-8000-000000000003",
  mac: "019f9000-0000-7000-8000-000000000004",
};

async function refreshManifestSetId(fixture: Fixture): Promise<string> {
  const forIdentity = Object.fromEntries(
    TARGET_DEFINITIONS.map((definition) => [definition.key, {
      ...fixture.metas[definition.key],
      metadata_sha256: `sha256:${"0".repeat(64)}`,
    }]),
  ) as unknown as Record<TargetKey, ValidatedMetadata>;
  const manifestSetId = await computeManifestSetId(forIdentity);
  for (const definition of TARGET_DEFINITIONS) {
    fixture.metas[definition.key].manifest_set_id = manifestSetId;
  }
  return manifestSetId;
}

async function writeMetas(fixture: Fixture): Promise<void> {
  for (const definition of TARGET_DEFINITIONS) {
    await Deno.writeTextFile(
      fixture.input.artifacts[definition.key].metaPath,
      `${JSON.stringify(fixture.metas[definition.key], null, 2)}\n`,
    );
  }
}

async function createFixture(appVersion2 = "12.16.4"): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "stable-update-v2-test-" });
  const outputRoot = `${root}/browser/stable`;
  await Deno.mkdir(outputRoot, { recursive: true });
  const statePath = `${outputRoot}/stable-state.json`;
  const bootstrapUrl = new URL(
    "../browser/stable/stable-state.json",
    import.meta.url,
  );
  await Deno.copyFile(bootstrapUrl, statePath);

  const artifacts = {} as Record<
    TargetKey,
    StableUpdateInput["artifacts"][TargetKey]
  >;
  const metas = {} as Record<TargetKey, Record<string, unknown>>;
  for (let index = 0; index < TARGET_DEFINITIONS.length; index++) {
    const definition = TARGET_DEFINITIONS[index];
    const marBytes = new TextEncoder().encode(`test MAR ${definition.key}`);
    const marPath = `${root}/${definition.assetName}`;
    const metaPath = `${root}/${definition.metaName}`;
    const marUrl = canonicalReleaseUrl(appVersion2, definition.assetName);
    await Deno.writeFile(marPath, marBytes);
    artifacts[definition.key] = { marPath, metaPath, marUrl };
    metas[definition.key] = {
      schema_version: 2,
      version_display: `${appVersion2}@153.0`,
      version: "153.0",
      noraneko_version: appVersion2,
      buildid: BUILD_IDS[definition.key],
      noraneko_buildid: BUILD_IDS_2[definition.key],
      channel: "release",
      platform: definition.platform,
      arch: definition.metadataArch,
      manifest_set_id: "pending",
      mar: {
        url: marUrl,
        name: definition.assetName,
        size: marBytes.byteLength,
        sha512: await hexDigest("SHA-512", marBytes),
      },
      provenance: {
        runtime_repository: "Floorp-Projects/Floorp-Runtime",
        runtime_head_sha: "b".repeat(40),
        runtime_run_id: 1000,
        runtime_artifact_id: 2000 + index,
        runtime_artifact_digest: `sha256:${
          (index + 5).toString(16).repeat(64)
        }`,
        floorp_repository: "Floorp-Projects/Floorp",
        floorp_head_sha: "a".repeat(40),
        floorp_run_id: 3000,
        release_tag: `v${appVersion2}`,
      },
      verification: {
        status: "verified",
        method: "full-version",
        app_build_id: BUILD_IDS[definition.key],
        build_id2: BUILD_IDS_2[definition.key],
      },
    };
  }

  const fixture: Fixture = {
    root,
    input: {
      firefoxVersion: "153.0",
      appVersion2,
      artifacts,
      statePath,
      outputRoot,
    },
    metas,
  };
  await refreshManifestSetId(fixture);
  await writeMetas(fixture);
  return fixture;
}

async function usingFixture(
  action: (fixture: Fixture) => Promise<void>,
  appVersion2 = "12.16.4",
): Promise<void> {
  const fixture = await createFixture(appVersion2);
  try {
    await action(fixture);
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
}

Deno.test("semantic version comparison follows SemVer precedence", () => {
  assert(compareSemVer("12.16.4", "12.16.3") > 0);
  assert(compareSemVer("12.17.0", "12.16.99") > 0);
  assert(compareSemVer("12.17.0-rc.2", "12.17.0-rc.1") > 0);
  assert(compareSemVer("12.17.0", "12.17.0-rc.2") > 0);
  assertEquals(compareSemVer("12.17.0+build.2", "12.17.0+build.1"), 0);
});

Deno.test("Firefox dotted-version comparison prevents engine rollback", () => {
  assert(compareFirefoxVersion("154.0", "153.0.9") > 0);
  assert(compareFirefoxVersion("153.0.1", "153.0") > 0);
  assertEquals(compareFirefoxVersion("153.0", "153.0.0"), 0);
  assert(compareFirefoxVersion("152.9.9", "153.0") < 0);
});

Deno.test("valid schema-v2 manifest set validates all four downloaded MARs", async () => {
  await usingFixture(async (fixture) => {
    const manifest = await validateManifestSet(fixture.input);
    assertEquals(manifest.appVersion2, "12.16.4");
    assertEquals(
      manifest.manifestSetId,
      fixture.metas.windows.manifest_set_id,
    );
  });
});

const invalidCases: Array<{
  name: string;
  expected: string;
  mutate: (fixture: Fixture) => unknown | Promise<unknown>;
}> = [
  {
    name: "schema version",
    expected: "windows.schema_version",
    mutate: (fixture) => fixture.metas.windows.schema_version = 1,
  },
  {
    name: "Firefox version",
    expected: "windows.version",
    mutate: (fixture) => fixture.metas.windows.version = "152.0",
  },
  {
    name: "metadata display version order",
    expected: "windows.version_display",
    mutate: (fixture) =>
      fixture.metas.windows.version_display = "153.0@12.16.4",
  },
  {
    name: "invalid UTC buildid",
    expected: "not a valid UTC timestamp",
    mutate: (fixture) => fixture.metas.windows.buildid = "20260230010101",
  },
  {
    name: "non-UUIDv7 buildid2",
    expected: "windows.noraneko_buildid has an invalid format",
    mutate: (fixture) =>
      fixture.metas.windows.noraneko_buildid =
        "019f9000-0000-6000-8000-000000000001",
  },
  {
    name: "channel",
    expected: "windows.channel",
    mutate: (fixture) => fixture.metas.windows.channel = "beta",
  },
  {
    name: "platform",
    expected: "windows.platform",
    mutate: (fixture) => fixture.metas.windows.platform = "Linux",
  },
  {
    name: "architecture",
    expected: "windows.arch",
    mutate: (fixture) => fixture.metas.windows.arch = "aarch64",
  },
  {
    name: "MAR URL",
    expected: "windows.mar.url",
    mutate: (fixture) =>
      nested(fixture.metas.windows, "mar").url =
        "https://example.invalid/file.mar",
  },
  {
    name: "MAR asset name",
    expected: "windows.mar.name",
    mutate: (fixture) =>
      nested(fixture.metas.windows, "mar").name = "wrong.mar",
  },
  {
    name: "MAR size",
    expected: "windows.mar.size versus downloaded MAR",
    mutate: (fixture) => nested(fixture.metas.windows, "mar").size = 999,
  },
  {
    name: "MAR SHA512",
    expected: "windows.mar.sha512 versus downloaded MAR",
    mutate: (fixture) =>
      nested(fixture.metas.windows, "mar").sha512 = "f".repeat(128),
  },
  {
    name: "Runtime repository provenance",
    expected: "windows.provenance.runtime_repository",
    mutate: (fixture) =>
      nested(fixture.metas.windows, "provenance").runtime_repository =
        "wrong/repo",
  },
  {
    name: "Floorp head SHA provenance",
    expected: "windows.provenance.floorp_head_sha has an invalid format",
    mutate: (fixture) =>
      nested(fixture.metas.windows, "provenance").floorp_head_sha = "not-a-sha",
  },
  {
    name: "verification status",
    expected: "windows.verification.status",
    mutate: (fixture) =>
      nested(fixture.metas.windows, "verification").status = "unverified",
  },
  {
    name: "verified application build ID",
    expected: "windows.verification.app_build_id",
    mutate: (fixture) =>
      nested(fixture.metas.windows, "verification").app_build_id =
        "20260722000000",
  },
];

for (const invalidCase of invalidCases) {
  Deno.test(`fail closed on invalid ${invalidCase.name}`, async () => {
    await usingFixture(async (fixture) => {
      await invalidCase.mutate(fixture);
      await writeMetas(fixture);
      await assertRejects(
        () => validateManifestSet(fixture.input),
        invalidCase.expected,
      );
    });
  });
}

Deno.test("rejects a manifest ID not derived from canonical provenance and target identities", async () => {
  await usingFixture(async (fixture) => {
    for (const definition of TARGET_DEFINITIONS) {
      fixture.metas[definition.key].manifest_set_id = `sha256:${
        "f".repeat(64)
      }`;
    }
    await writeMetas(fixture);
    await assertRejects(
      () => validateManifestSet(fixture.input),
      "manifest_set_id versus canonical manifest set",
    );
  });
});

Deno.test("rejects manifest-set disagreement across platform metadata", async () => {
  await usingFixture(async (fixture) => {
    fixture.metas.linux.manifest_set_id = `sha256:${"e".repeat(64)}`;
    await writeMetas(fixture);
    await assertRejects(
      () => validateManifestSet(fixture.input),
      "linux.manifest_set_id across manifest set",
    );
  });
});

Deno.test("rejects a manifest set mixed from different Runtime runs", async () => {
  await usingFixture(async (fixture) => {
    nested(fixture.metas.linux, "provenance").runtime_run_id = 9999;
    await writeMetas(fixture);
    await assertRejects(
      () => validateManifestSet(fixture.input),
      "linux.provenance.runtime_run_id across manifest set",
    );
  });
});

Deno.test("generates all five XMLs with verified SHA512 before publishing state", async () => {
  await usingFixture(async (fixture) => {
    assertEquals(await applyStableUpdate(fixture.input), "updated");
    const paths = [
      "WINNT/x86_64/update.xml",
      "Linux/x86_64/update.xml",
      "Linux/aarch64/update.xml",
      "Darwin/x86_64/update.xml",
      "Darwin/aarch64/update.xml",
    ];
    for (const path of paths) {
      const xml = await Deno.readTextFile(
        `${fixture.input.outputRoot}/${path}`,
      );
      assert(xml.includes('displayVersion="153.0@12.16.4"'));
      assert(xml.includes('hashFunction="sha512"'));
      assert(xml.includes('hashValue="'));
    }
    assertEquals(
      await Deno.readTextFile(
        `${fixture.input.outputRoot}/Darwin/x86_64/update.xml`,
      ),
      await Deno.readTextFile(
        `${fixture.input.outputRoot}/Darwin/aarch64/update.xml`,
      ),
    );
    const state = JSON.parse(await Deno.readTextFile(fixture.input.statePath));
    assertEquals(state.status, "verified");
    assertEquals(state.manifest_set_id, fixture.metas.windows.manifest_set_id);
    assertEquals(Object.keys(state.targets).length, 5);
  });
});

Deno.test("validation failure leaves every existing endpoint untouched", async () => {
  await usingFixture(async (fixture) => {
    const paths = TARGET_DEFINITIONS.flatMap((definition) =>
      definition.endpoints.map(([platform, arch]) =>
        `${platform}/${arch}/update.xml`
      )
    );
    for (const path of paths) {
      await Deno.mkdir(
        `${fixture.input.outputRoot}/${
          path.substring(0, path.lastIndexOf("/"))
        }`,
        {
          recursive: true,
        },
      );
      await Deno.writeTextFile(
        `${fixture.input.outputRoot}/${path}`,
        `sentinel:${path}`,
      );
    }
    nested(fixture.metas.linux, "mar").sha512 = "0".repeat(128);
    await writeMetas(fixture);
    await assertRejects(
      () => applyStableUpdate(fixture.input),
      "linux.mar.sha512 versus downloaded MAR",
    );
    for (const path of paths) {
      assertEquals(
        await Deno.readTextFile(`${fixture.input.outputRoot}/${path}`),
        `sentinel:${path}`,
      );
    }
  });
});

Deno.test("state transition rejects rollback and equivocation, but same manifest is a no-op", async () => {
  await usingFixture(async (fixture) => {
    const manifest = await validateManifestSet(fixture.input);
    const next = buildVerifiedState(manifest);
    const legacy = JSON.parse(
      await Deno.readTextFile(fixture.input.statePath),
    ) as LegacyState;
    assertEquals(determineTransition(legacy, next), "update");

    const sameLegacyVersion = structuredClone(next);
    sameLegacyVersion.app_version2 = legacy.app_version2;
    await assertRejects(
      () => determineTransition(legacy, sameLegacyVersion),
      "legacy bootstrap only accepts a newer app version",
    );

    const engineDowngrade = structuredClone(next);
    engineDowngrade.app_version2 = "12.17.0";
    engineDowngrade.version = "152.0";
    engineDowngrade.manifest_set_id = `sha256:${"d".repeat(64)}`;
    await assertRejects(
      () => determineTransition(next, engineDowngrade),
      "must not downgrade Firefox version from 153.0 to 152.0",
    );

    assertEquals(determineTransition(next, structuredClone(next)), "noop");

    const reusedId = structuredClone(next);
    reusedId.targets[Object.keys(reusedId.targets)[0]].size++;
    await assertRejects(
      () => determineTransition(next, reusedId),
      "manifest_set_id was reused",
    );

    const sameVersionDifferentManifest = structuredClone(next);
    sameVersionDifferentManifest.manifest_set_id = `sha256:${"f".repeat(64)}`;
    await assertRejects(
      () => determineTransition(next, sameVersionDifferentManifest),
      "new manifest must have a newer app version",
    );

    const older = structuredClone(sameVersionDifferentManifest);
    older.app_version2 = "12.16.3";
    await assertRejects(
      () => determineTransition(next, older),
      "new manifest must have a newer app version",
    );

    const newer = structuredClone(
      sameVersionDifferentManifest,
    ) as VerifiedState;
    newer.app_version2 = "12.17.0";
    assertEquals(determineTransition(next, newer), "update");
  });
});

Deno.test("applying the exact same verified manifest performs no writes", async () => {
  await usingFixture(async (fixture) => {
    assertEquals(await applyStableUpdate(fixture.input), "updated");
    const before = await Deno.readTextFile(fixture.input.statePath);
    assertEquals(await applyStableUpdate(fixture.input), "noop");
    assertEquals(await Deno.readTextFile(fixture.input.statePath), before);
  });
});

Deno.test("legacy delivery workflow cannot target stable, rc, or beta", async () => {
  const workflow = await Deno.readTextFile(
    new URL(
      "../.github/workflows/deliver-updates-to-floorp-browser.yml",
      import.meta.url,
    ),
  );
  assert(
    workflow.includes(
      'if [[ ! "$dir" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then',
    ),
    "legacy directory loop must allowlist numeric version directories",
  );
  assert(
    workflow.includes(
      "^browser/[0-9]+\\.[0-9]+\\.[0-9]+/(WINNT|Linux|Darwin)/(x86_64|x86|aarch64)/update\\.xml$",
    ),
    "legacy staging must enforce the per-version endpoint allowlist",
  );
  assert(
    !workflow.includes('if [[ "$dir" != "beta" ]]'),
    "a beta-only denylist would leave stable and rc writable",
  );
  assert(
    !workflow.includes("git add ."),
    "legacy workflow must not stage the repository broadly",
  );
  assert(
    !workflow.includes("git pull -r"),
    "legacy workflow must reject drift instead of rebasing generated output",
  );
});

Deno.test("v2 workflow serializes writers and rejects stale broad git updates", async () => {
  const workflow = await Deno.readTextFile(
    new URL(
      "../.github/workflows/update-stable-updatexml-files-v2.yml",
      import.meta.url,
    ),
  );
  for (
    const input of [
      "win-mar-url",
      "linux-mar-url",
      "linux-aarch64-mar-url",
      "mac-mar-url",
      "win-meta-url",
      "linux-meta-url",
      "linux-aarch64-meta-url",
      "mac-meta-url",
      "firefox-version",
      "app-version2",
      "request-id",
      "dry-run",
    ]
  ) {
    assert(workflow.includes(`      ${input}:`), `missing v2 input ${input}`);
  }
  assert(workflow.includes("group: floorp-updates-writer"));
  assert(workflow.includes("cancel-in-progress: false"));
  assert(workflow.includes("REMOTE_SHA=$(git rev-parse origin/main)"));
  assert(workflow.includes('if [[ "$REMOTE_SHA" != "$BASE_SHA" ]]'));
  assert(workflow.includes("git add -- \\"));
  assert(!workflow.includes("git add ."));
  assert(!workflow.includes("git pull -r"));
  assert(workflow.includes("git push origin HEAD:main"));
  assert(workflow.includes("stable-update-result-${{ inputs['request-id'] }}"));
});

Deno.test("Cloudflare production deploy is main-only and pinned to the pushed SHA", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../.github/workflows/upload-cfp.yml", import.meta.url),
  );
  assert(workflow.includes("      - main"));
  assert(workflow.includes("github.ref == 'refs/heads/main'"));
  assert(workflow.includes("ref: ${{ github.sha }}"));
  assert(workflow.includes('if [[ "$CHECKED_OUT_SHA" != "$GITHUB_SHA" ]]'));
  assert(workflow.includes("git ls-remote --exit-code origin refs/heads/main"));
  assert(workflow.includes('if [[ "$LATEST_MAIN_SHA" != "$GITHUB_SHA" ]]'));
  assert(workflow.includes("--commit-hash=${{ github.sha }}"));
  assert(!workflow.includes("on: [push]"));
});
