// @ts-check
// The club's page text and photos, gathered by `npm run content` (scripts/club-content.mjs)
// from clubs/<club>/ (committed placeholders) or clubs/<club>/drafts/ (local demo only).
// Checked again here, so the Worker never serves a tag that isn't on the allowed list.

import { parseContent } from "./club-content-check.js";
import raw from "./generated/club-content.json" with { type: "json" };

export const CONTENT = parseContent(raw);
