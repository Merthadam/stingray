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

Other dependencies retain their own licenses in node_modules and package-lock.json records. Review them before distribution.
