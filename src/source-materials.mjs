import fs from "node:fs";
import { parseSourceOutline } from "./replication.mjs";

// Omitted expectedEpisodes infers the source count, never the planned output count.
export function normalizeSourceMaterials(value, expectedEpisodes = undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("源材料必须是包含 creative、characters、outline、provenance 的 JSON 对象");
  }
  for (const field of ["creative", "characters", "outline"]) {
    if (typeof value[field] !== "string" || !value[field].trim()) {
      throw new Error(`源材料 ${field} 必须是非空文本`);
    }
  }
  parseSourceOutline(value.outline, expectedEpisodes);
  if (!value.provenance || typeof value.provenance !== "object" || Array.isArray(value.provenance)) {
    throw new Error("源材料 provenance 必须是来源信息对象");
  }
  return {
    creative: value.creative,
    characters: value.characters,
    outline: value.outline,
    provenance: value.provenance,
  };
}

export function loadSourceMaterials(file, expectedEpisodes) {
  return normalizeSourceMaterials(JSON.parse(fs.readFileSync(file, "utf8")), expectedEpisodes);
}
