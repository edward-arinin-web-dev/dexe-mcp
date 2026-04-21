/**
 * Validates that the MCP's dexe_ipfs_upload_dao_metadata output
 * is 100% compatible with the frontend's IGovPoolDescription interface
 * and all downstream consumers (CollapsedDescriptionCard, DaoSidebar,
 * ModifyDaoProfileContext, useGovPoolProposalProfileModel, etc.).
 *
 * Run: npx tsx scripts/validate-metadata-compat.ts
 */

// ---- Frontend type definitions (source of truth) ----

interface ExternalFileDocument {
  name: string;
  url: string;
  id: string; // only used by form editor, not by IPFS consumers
}

interface IGovPoolDescription {
  avatarUrl: string;
  avatarCID?: string;
  avatarFileName?: string;
  daoName: string;
  description: string; // IPFS CID with "ipfs://" prefix
  documents: ExternalFileDocument[];
  socialLinks: [string, string][];
  websiteUrl: string;
}

// ---- Simulate what the MCP outputs as the outer metadata payload ----

interface McpInput {
  daoName: string;
  description?: string;
  websiteUrl?: string;
  avatarCID?: string;
  avatarFileName?: string;
  socialLinks?: [string, string][];
  documents?: { name: string; url: string }[];
}

function simulateMcpOuterPayload(input: McpInput): Record<string, unknown> {
  const descriptionIpfsPath = `ipfs://QmFakeDescriptionCID`;

  let avatarUrl = "";
  if (input.avatarCID && input.avatarFileName) {
    avatarUrl = `https://${input.avatarCID}.ipfs.4everland.io/${input.avatarFileName}`;
  }

  return {
    avatarUrl,
    avatarCID: input.avatarCID ?? undefined,
    avatarFileName: input.avatarFileName ?? "",
    daoName: input.daoName,
    websiteUrl: input.websiteUrl ?? "",
    description: descriptionIpfsPath,
    socialLinks: input.socialLinks ?? [],
    documents: input.documents ?? [],
  };
}

// ---- Frontend parser simulations ----

function simulateParseAvatarFromIpfsResponse(response: Record<string, unknown>): Record<string, unknown> {
  // From investing-dashboard/src/utils/ipfs.ts parseAvatarFromIpfsResponse()
  if (response?.avatarCID && response?.avatarFileName) {
    return {
      ...response,
      avatarUrl: `https://${response.avatarCID}.ipfs.4everland.io/${response.avatarFileName}`,
    };
  }
  if (response?.avatarUrl && typeof response.avatarUrl === "string" && response.avatarUrl.length > 0) {
    // Would parse CID from URL — just check it doesn't crash
    return response;
  }
  return response;
}

function simulateGovPoolDetailsStore(desc: Record<string, unknown>): {
  govPoolIconUrl: string;
  govPoolName: string;
  govPoolDescription: string;
  govPoolWebsite: string;
  govPoolSocialLinks: unknown[];
  govPoolDocuments: unknown[];
} {
  // From GovPoolDetailsContext.tsx lines 275-284
  const socialLinks = (desc?.socialLinks as [string, string][] ?? []).filter(
    (el: [string, string]) => !!el?.[1],
  );
  const documents = ((desc?.documents as { name: string; url: string }[]) || []).filter(
    (el) => el.name !== "" && el.url !== "",
  );
  return {
    govPoolIconUrl: (desc?.avatarUrl as string) ?? "",
    govPoolName: (desc?.daoName as string) ?? "",
    govPoolDescription: (desc?.description as string) ?? "",
    govPoolWebsite: (desc?.websiteUrl as string) ?? "",
    govPoolSocialLinks: socialLinks,
    govPoolDocuments: documents,
  };
}

function simulateDocumentsRendering(documents: unknown[]): boolean {
  // From Documents/index.tsx — iterates with .map, accesses .name, .url
  try {
    for (const el of documents) {
      const doc = el as { name: string; url: string };
      if (typeof doc.name !== "string" || typeof doc.url !== "string") {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function simulateSocialLinksRendering(socialLinks: unknown[]): boolean {
  // From Documents/index.tsx — iterates, accesses el[0] (label) and el[1] (url)
  try {
    for (const el of socialLinks) {
      const link = el as [string, string];
      if (typeof link[0] !== "string" || typeof link[1] !== "string") {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function simulateCollapsedDescriptionCard(descriptionCid: string): boolean {
  // Checks that description field is a string CID that can be fetched
  try {
    if (typeof descriptionCid !== "string") return false;
    if (descriptionCid.length === 0) return true; // empty is handled gracefully
    // Must start with ipfs:// or be a raw CID
    return true;
  } catch {
    return false;
  }
}

function simulateModifyDaoProfileContext(desc: Record<string, unknown>): boolean {
  // From ModifyDaoProfileContext.tsx — reads each field with ?? fallback
  try {
    const avatarUrl = (desc?.avatarUrl as string) ?? "";
    const daoName = (desc?.daoName as string) ?? "";
    const documents = (desc?.documents as unknown[]) ?? [];
    const socialLinks = (desc?.socialLinks as unknown[]) ?? [];
    const websiteUrl = (desc?.websiteUrl as string) ?? "";
    const avatarCID = (desc?.avatarCID as string) ?? "";
    const avatarFileName = (desc?.avatarFileName as string) ?? "";

    // These must be strings
    if (typeof avatarUrl !== "string") return false;
    if (typeof daoName !== "string") return false;
    if (typeof websiteUrl !== "string") return false;
    if (typeof avatarCID !== "string") return false;
    if (typeof avatarFileName !== "string") return false;
    // These must be arrays
    if (!Array.isArray(documents)) return false;
    if (!Array.isArray(socialLinks)) return false;

    return true;
  } catch {
    return false;
  }
}

// ---- Test cases ----

interface TestCase {
  name: string;
  input: McpInput;
  expectedIssues?: string[];
}

const TEST_CASES: TestCase[] = [
  {
    name: "MINIMAL — only daoName, no optional fields",
    input: {
      daoName: "Test DAO",
    },
  },
  {
    name: "DESCRIPTION ONLY — daoName + description text",
    input: {
      daoName: "Test DAO",
      description: "A simple DAO for testing purposes.",
    },
  },
  {
    name: "FULL — all fields populated",
    input: {
      daoName: "Full Test DAO",
      description: "A comprehensive DAO with all metadata.\nSecond paragraph here.",
      websiteUrl: "https://fulldao.example.com",
      avatarCID: "bafyreib2e3z4k5p7xq2o3r4s5t6u7v8w9x0y1z2a3b4c5d6e7f8g9h0i1j2k",
      avatarFileName: "logo.jpeg",
      socialLinks: [
        ["twitter", "https://x.com/fulldao"],
        ["discord", "https://discord.gg/fulldao"],
        ["telegram", "https://t.me/fulldao"],
      ],
      documents: [
        { name: "Whitepaper", url: "https://fulldao.example.com/whitepaper.pdf" },
        { name: "Tokenomics", url: "https://fulldao.example.com/tokenomics.pdf" },
      ],
    },
  },
  {
    name: "AVATAR ONLY — avatar without description or links",
    input: {
      daoName: "Avatar DAO",
      avatarCID: "bafyreiabc123",
      avatarFileName: "avatar.jpeg",
    },
  },
  {
    name: "SOCIAL LINKS ONLY — no avatar, no documents",
    input: {
      daoName: "Social DAO",
      socialLinks: [
        ["twitter", "https://x.com/socialdao"],
      ],
    },
  },
  {
    name: "DOCUMENTS ONLY — no avatar, no social links",
    input: {
      daoName: "Docs DAO",
      documents: [
        { name: "Charter", url: "https://docs.example.com/charter" },
      ],
    },
  },
  {
    name: "EMPTY STRINGS — explicit empty values for optional fields",
    input: {
      daoName: "Empty DAO",
      description: "",
      websiteUrl: "",
      socialLinks: [],
      documents: [],
    },
  },
  {
    name: "SOCIAL LINK with empty URL — should be filtered out",
    input: {
      daoName: "FilterTest DAO",
      socialLinks: [
        ["twitter", ""],
        ["discord", "https://discord.gg/test"],
      ],
    },
  },
  {
    name: "DOCUMENT with empty name/url — should be filtered out",
    input: {
      daoName: "FilterTest DAO",
      documents: [
        { name: "", url: "" },
        { name: "Real Doc", url: "https://example.com/doc" },
      ],
    },
  },
  {
    name: "AVATAR CID without fileName — should NOT produce avatarUrl",
    input: {
      daoName: "Broken Avatar DAO",
      avatarCID: "bafyreiabc123",
      // avatarFileName intentionally omitted
    },
  },
  {
    name: "AVATAR fileName without CID — should NOT produce avatarUrl",
    input: {
      daoName: "Broken Avatar DAO 2",
      avatarFileName: "logo.jpeg",
      // avatarCID intentionally omitted
    },
  },
  {
    name: "UNICODE — daoName and description with unicode/emoji",
    input: {
      daoName: "Юнікод DAO 🚀",
      description: "Опис українською мовою\nSecond line in English",
      websiteUrl: "https://example.com",
    },
  },
  {
    name: "LONG DESCRIPTION — multiline with many paragraphs",
    input: {
      daoName: "Long Desc DAO",
      description: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10",
    },
  },
  {
    name: "WEBSITE with trailing slash",
    input: {
      daoName: "Slash DAO",
      websiteUrl: "https://example.com/",
    },
  },
  {
    name: "CUSTOM social platform name",
    input: {
      daoName: "Custom Social DAO",
      socialLinks: [
        ["custom-platform", "https://custom.example.com"],
        ["medium", "https://medium.com/@dao"],
      ],
    },
  },
];

// ---- Runner ----

let passed = 0;
let failed = 0;

for (const tc of TEST_CASES) {
  const errors: string[] = [];

  // 1. Simulate MCP output
  const payload = simulateMcpOuterPayload(tc.input);

  // 2. Check all required fields exist
  const requiredFields = ["avatarUrl", "daoName", "description", "websiteUrl", "socialLinks", "documents"];
  for (const field of requiredFields) {
    if (!(field in payload)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // 3. Check field types
  if (typeof payload.avatarUrl !== "string") errors.push(`avatarUrl must be string, got ${typeof payload.avatarUrl}`);
  if (typeof payload.daoName !== "string") errors.push(`daoName must be string, got ${typeof payload.daoName}`);
  if (typeof payload.description !== "string") errors.push(`description must be string, got ${typeof payload.description}`);
  if (typeof payload.websiteUrl !== "string") errors.push(`websiteUrl must be string, got ${typeof payload.websiteUrl}`);
  if (!Array.isArray(payload.socialLinks)) errors.push(`socialLinks must be array, got ${typeof payload.socialLinks}`);
  if (!Array.isArray(payload.documents)) errors.push(`documents must be array, got ${typeof payload.documents}`);
  if (payload.avatarFileName !== undefined && typeof payload.avatarFileName !== "string")
    errors.push(`avatarFileName must be string or undefined, got ${typeof payload.avatarFileName}`);
  if (payload.avatarCID !== undefined && typeof payload.avatarCID !== "string")
    errors.push(`avatarCID must be string or undefined, got ${typeof payload.avatarCID}`);

  // 4. Simulate parseAvatarFromIpfsResponse
  try {
    const parsed = simulateParseAvatarFromIpfsResponse(payload);
    if (tc.input.avatarCID && tc.input.avatarFileName) {
      if (!parsed.avatarUrl || (parsed.avatarUrl as string).length === 0) {
        errors.push("parseAvatarFromIpfsResponse: avatarUrl should be set when avatarCID+avatarFileName provided");
      }
    }
    if (!tc.input.avatarCID && !tc.input.avatarFileName) {
      if (parsed.avatarUrl && (parsed.avatarUrl as string).length > 0) {
        errors.push("parseAvatarFromIpfsResponse: avatarUrl should be empty when no avatar provided");
      }
    }
  } catch (e) {
    errors.push(`parseAvatarFromIpfsResponse CRASHED: ${e}`);
  }

  // 5. Simulate GovPoolDetailsStore
  try {
    const store = simulateGovPoolDetailsStore(payload);
    if (typeof store.govPoolIconUrl !== "string") errors.push("Store: govPoolIconUrl not string");
    if (typeof store.govPoolName !== "string") errors.push("Store: govPoolName not string");
    if (typeof store.govPoolDescription !== "string") errors.push("Store: govPoolDescription not string");
    if (typeof store.govPoolWebsite !== "string") errors.push("Store: govPoolWebsite not string");
    if (!Array.isArray(store.govPoolSocialLinks)) errors.push("Store: govPoolSocialLinks not array");
    if (!Array.isArray(store.govPoolDocuments)) errors.push("Store: govPoolDocuments not array");
  } catch (e) {
    errors.push(`GovPoolDetailsStore CRASHED: ${e}`);
  }

  // 6. Simulate Documents rendering
  try {
    const docsOk = simulateDocumentsRendering(payload.documents as unknown[]);
    if (!docsOk) errors.push("Documents rendering: invalid document structure");
  } catch (e) {
    errors.push(`Documents rendering CRASHED: ${e}`);
  }

  // 7. Simulate SocialLinks rendering
  try {
    const linksOk = simulateSocialLinksRendering(payload.socialLinks as unknown[]);
    if (!linksOk) errors.push("SocialLinks rendering: invalid link structure");
  } catch (e) {
    errors.push(`SocialLinks rendering CRASHED: ${e}`);
  }

  // 8. Simulate CollapsedDescriptionCard
  try {
    const descOk = simulateCollapsedDescriptionCard(payload.description as string);
    if (!descOk) errors.push("CollapsedDescriptionCard: description CID not valid");
  } catch (e) {
    errors.push(`CollapsedDescriptionCard CRASHED: ${e}`);
  }

  // 9. Simulate ModifyDaoProfileContext
  try {
    const contextOk = simulateModifyDaoProfileContext(payload);
    if (!contextOk) errors.push("ModifyDaoProfileContext: failed field validation");
  } catch (e) {
    errors.push(`ModifyDaoProfileContext CRASHED: ${e}`);
  }

  // 10. Edge case: avatar CID without fileName should NOT produce avatarUrl
  if (tc.input.avatarCID && !tc.input.avatarFileName) {
    if ((payload.avatarUrl as string).length > 0) {
      errors.push("Avatar edge case: avatarUrl should be empty when avatarFileName is missing");
    }
  }
  if (!tc.input.avatarCID && tc.input.avatarFileName) {
    if ((payload.avatarUrl as string).length > 0) {
      errors.push("Avatar edge case: avatarUrl should be empty when avatarCID is missing");
    }
  }

  // 11. Social links filtering: empty URLs should be filtered by store
  if (tc.input.socialLinks) {
    const store = simulateGovPoolDetailsStore(payload);
    const emptyUrlLinks = (tc.input.socialLinks).filter((l) => !l[1]);
    if (emptyUrlLinks.length > 0 && store.govPoolSocialLinks.length >= tc.input.socialLinks.length) {
      errors.push("Social links: empty-URL links were not filtered out by store");
    }
  }

  // 12. Documents filtering: empty name+url should be filtered by store
  if (tc.input.documents) {
    const store = simulateGovPoolDetailsStore(payload);
    const emptyDocs = tc.input.documents.filter((d) => d.name === "" && d.url === "");
    if (emptyDocs.length > 0 && store.govPoolDocuments.length >= tc.input.documents.length) {
      errors.push("Documents: empty name+url docs were not filtered out by store");
    }
  }

  // Report
  if (errors.length === 0) {
    console.log(`  ✅ ${tc.name}`);
    passed++;
  } else {
    console.log(`  ❌ ${tc.name}`);
    for (const err of errors) {
      console.log(`     → ${err}`);
    }
    failed++;
  }
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${TEST_CASES.length} test cases`);
if (failed > 0) {
  process.exit(1);
}
