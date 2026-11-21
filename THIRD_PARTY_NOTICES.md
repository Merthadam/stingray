# Third-party notices

The warm dark UI/terminal palette is adapted from Superset's `packages/shared/src/themes/built-in/ember.ts`, source commit `9c6f098329dd3d6956bd3c19da73d2ab7d9bb1d6` (desktop package 2.0.5). The layout is inspired by Superset; Stingray is independent and not affiliated. No Superset logos or bundled executable artifacts are redistributed.

The compact workspace port badge/popover interaction and terminal-descendant listener-discovery approach were also informed by read-only inspection of Superset 1.29.0's shipped JavaScript/source maps (`DashboardSidebarPortsChip`, `DashboardSidebarPortHoverRow`, and `@superset/port-scanner`). Stingray's implementation is local-only and does not include Superset's remote forwarding or port-killing behavior. Extracted reference artifacts are kept in ignored local analysis directories, not distributed with the app.

MIT License

Copyright (c) 2025-2026 Superset Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The Database tab parses Python with `web-tree-sitter` 0.25.10 (shipped in `node_modules/web-tree-sitter`) and the tree-sitter-python grammar compiled to WebAssembly (`dist-electron/tree-sitter-python.wasm`, SHA-256 `a7fdc587e77bd729b9f5b783c659be23c896e305a2c374472bed7114d9e01fac`, built with tree-sitter-cli 0.25.10).

web-tree-sitter:

The MIT License (MIT)

Copyright (c) 2018-2024 Max Brunsfeld

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

tree-sitter-python:

The MIT License (MIT)

Copyright (c) 2016 Max Brunsfeld

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Live views use CodeGraph 1.6.2 (`@colbymchenry/codegraph` and `@colbymchenry/codegraph-darwin-arm64`, https://github.com/colbymchenry/codegraph), shipped in `node_modules/@colbymchenry` without its bundled Node runtime and CLI launcher. Both packages declare the MIT license (package.json and README) but ship no license file. The platform package bundles its production dependencies with their own license files in `lib/node_modules`: web-tree-sitter 0.25.10, commander 14.0.3, ignore 7.0.5, jsonc-parser 3.3.1, picomatch 4.0.7, @clack/core and @clack/prompts 1.3.0, fast-string-width 3.0.2, fast-string-truncated-width 3.0.3, fast-wrap-ansi 0.2.0, sisteransi 1.0.5 (MIT) and tree-sitter-wasms 0.1.13 (Unlicense). It also ships prebuilt tree-sitter grammars (`lib/dist/extraction/wasm`) and a native parsing kernel (`lib/kernel/codegraph-kernel.node`) compiled from vendored grammar sources, without per-grammar license files. Its source names the vendored tree-sitter-terraform grammar (from @tree-sitter-grammars/tree-sitter-hcl 1.2.0) as Apache-2.0; review the remaining grammar licenses before distribution.

CodeGraph:

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The Views tab draws diagrams with React Flow (`@xyflow/react` 12.12.1 and `@xyflow/system` 0.0.84, MIT, bundled into `dist`) and lays them out with elkjs 0.12.1 (https://github.com/kieler/elkjs, bundled into `dist`, including the unmodified `elk-worker.min.js` web worker). elkjs is dual-licensed EPL-2.0 OR GPL-3.0; Stingray uses it under the Eclipse Public License 2.0, whose full text is in `node_modules/elkjs/LICENSE.md`; its source code is available at the URL above.

React Flow:

MIT License

Copyright (c) 2019-2025 webkid GmbH

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Other dependencies retain their own licenses in node_modules and package-lock.json records. Review them before distribution.

## Cloud architecture icons

Terraform and AWS CDK views draw cloud resources with the providers' official architecture icons, vendored unmodified
(only the icons the service catalog in `src/infra/catalog.ts` references) in `src/assets/infra-icons/`. They are used only
to depict those services in architecture diagrams, as each provider permits; they remain the property of their owners and
no endorsement is implied.

- `aws/`: AWS Architecture Icons, release 07312026 (service icons 48 px, "AWS Cloud" group icons, dark variants), from
  https://aws.amazon.com/architecture/icons/. © Amazon Web Services, Inc. or its affiliates. AWS allows customers and
  partners to use these assets to create architecture diagrams.
- `azure/`: Azure Public Service Icons V25, from https://learn.microsoft.com/azure/architecture/icons/. © Microsoft
  Corporation. Microsoft permits the use of these icons in architectural diagrams, training materials, or documentation;
  you can copy, distribute, and display the icons only for the permitted use unless granted explicit permission by
  Microsoft. Microsoft reserves all other rights. Icons must not be cropped, flipped, rotated, distorted or used to
  represent another product.
- `gcp/`: Google Cloud product icons (the "legacy" product icon set, consistent across the products covered), from
  https://cloud.google.com/icons, provided by Google for architecture diagrams and technical documentation. © Google LLC.
