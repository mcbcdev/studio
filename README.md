# studio.mcbcode

developer ide for all things minecraft

## what is this?

a developer ide for addon creators: professional, direct, and useful for both local packs and mcbCode cloud projects.

## how to use?

go to [studio.mcbcode](https://studio.mcbcode.com) and click the download icon on the right side of the url bar, or use the in-browser version.

## navigation and files

- **quick open** (`ctrl/cmd+p`) searches files in the active project and open editor tabs.
- **command palette** (`ctrl/cmd+shift+p`) runs editor, navigation, and view commands.
- the Explorer shows the active project's real file tree, or the tabs that are actually open. it shows **no files** when there is no project or open tab.
- **open file → open .mcpack / .mcaddon** imports a temporary local workspace. imports stay in the browser and are not uploaded to mcbCode. PNG/TGA images and supported audio formats have read-only previews.

## search and Bedrock authoring

- **workspace search** checks open buffers and project paths. choose **Search all project files** to explicitly scan text-file contents, including unopened cloud files. scans are bounded to 300 files, 2 mb per file, and 32 mb total; unavailable and oversized files are reported. regular expressions are length-limited and reject common nested-repetition patterns for search safety.
- project-wide replace is review-first. inspect the preview, then apply it. cloud changes are saved only after choosing **Apply replacements**; imported-pack edits remain in the browser until the pack is exported.
- JSON editors offer conservative Bedrock key/value hints with `ctrl/cmd+space` and manifest structure diagnostics. these are guidance, not a complete versioned schema or Minecraft runtime test. identifiers are suggested from open buffers and may be incomplete.
- `.js` files get **Bedrock Script API intellisense**: autocomplete, hover docs, parameter hints, auto-imports and API diagnostics for `@minecraft/server`, `server-ui`, `server-gametest`, `server-admin`, `server-net`, `debug-utilities`, `server-editor`, `common` and `vanilla-data`. it runs in the browser (TypeScript language service in a web worker) against the official `.d.ts` files in `js/script-api/definitions/`, nothing to install. use the **Script API: Stable / Beta** pill (bottom right of a `.js` editor) or the command palette to switch channels; beta-only apis are marked as beta. only open `.js` tabs can be imported from each other. to refresh the definitions run the **update script api definitions** workflow (Actions tab); see `tools/update-script-api.mjs`.
- **view → preview geometry** renders supported `minecraft:geometry` cubes as a live isometric preview. cube rotations, textures, and animations are not rendered yet.
- **Preferences → Bedrock authoring profile** stores a target Minecraft version and optional experiment notes per workspace in this browser. profile values do not modify pack files or replace testing in game.

editor find (`edit → find`) searches only the active file; workspace search covers files and paths in the project.

## source layout

the page shell is `index.html`; additive interface styles live in `css/studio.css`. JavaScript is split by feature under `js/`: `command-palette.js` handles quick open and commands, `project-search.js` handles explicit project-content scans and reviewed replacement, `bedrock-intelligence.js` provides editor hints, `geometry-preview.js` renders basic geometry, `studio-workbench.js` contains workspace search and editor preferences, and `local-files.js` handles archive import and export. `cloud-projects.js` handles project browsing and cloud file access.
