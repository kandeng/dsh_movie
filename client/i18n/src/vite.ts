import type { Plugin } from "vite";
import { transformSource } from "./transform.ts";

export function i18nPlugin(): Plugin {
  return {
    name: "dshMovieI18n",
    enforce: "pre",
    transform(source, id) {
      const path = id.replaceAll("\\", "/");
      // ACT: only transform the dsh_movie web client sources (client/web/src),
      // mirroring vidsay's apps/web/src scope for the message auto-extraction.
      if (!/\/client\/web\/src\//.test(path)) return;
      return transformSource(source, path);
    },
  };
}
