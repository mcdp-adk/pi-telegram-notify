# Write all code in TypeScript without a build

All code in the repo is TypeScript — the extension, its tests, the scripts the workflows run, and the tool configs — checked by the TypeScript compiler in `npm run lint`, with no build step: pi loads the `.ts` entry point directly through its jiti loader, Node runs the tests and scripts by stripping their types, and the published package ships the `.ts` source. Agents write most of this code and the owner reviews little of it line by line, so a type error that fails in seconds — a misspelt parameter, a wrong shape passed to pi, an unchecked field of parsed JSON — is worth more here than in a hand-written codebase. With every file under the compiler, `strict` and the unused-name checks cover what a JavaScript linter would, so the repo has no ESLint. Only erasable syntax is allowed, so the source Node and pi's loader run is exactly the source in the repo. The git hook stays a shell script, the only form git runs.

## Considered Options

- JavaScript with JSDoc annotations checked through `checkJs`: proves less — parsed JSON and caught errors stay weakly typed, the annotations rot separately from the code they describe, and nothing stops non-strippable syntax from reaching the loader.
- TypeScript for the extension only, with tests, scripts, and configs as `.mjs`: needs ESLint to catch undefined and unused names in the JavaScript half, and leaves the code that guards collaboration conventions unchecked.
- Compiling to JavaScript before publishing: the code pi runs would differ from the source in the repo, every release would depend on a build step staying in sync, and debugging an installed package would mean reading generated files.
