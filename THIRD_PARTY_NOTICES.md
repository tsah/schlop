# Third-party notices

Upstream review was performed on 2026-07-30. Schlop's source, tests, prompts, themes, and assets in this revision are a clean implementation: **no upstream source or substantial implementation was copied or adapted**. The projects below informed product research only, so their licenses are not incorporated into Schlop's source distribution as copied code.

| Project                                                               | Reviewed revision                          | License / copyright                              |
| --------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------ |
| [kitlangton/ghui](https://github.com/kitlangton/ghui)                 | `9d66e2f5ea1c1cbe231ac0a66a1fb4928a610e67` | MIT, © 2026 Kit Langton                          |
| [modem-dev/hunk](https://github.com/modem-dev/hunk)                   | `8e1f5fd265da3d0b45978db67350436cfaa05c05` | MIT, © Ben Vinegar                               |
| [agavra/tuicr](https://github.com/agavra/tuicr)                       | `567528413e2600c69579f8ec37330b1c0933cf52` | MIT, © 2025 tuicr contributors                   |
| [jnsahaj/lumen](https://github.com/jnsahaj/lumen)                     | `f60038908c66ef25be09d52c76334570fcfb67d0` | MIT, © 2024 Sahaj Jain                           |
| [backnotprop/plannotator](https://github.com/backnotprop/plannotator) | `b5cf065cbab1a5b0b5edaee90e140e73806504bc` | MIT OR Apache-2.0, MIT notice © 2025 backnotprop |
| [robzolkos/pi-slopchop](https://github.com/robzolkos/pi-slopchop)     | `f2cae8837dc47e3ceca9973d221a57e05bb4c05c` | MIT, © 2026 Rob Zolkos                           |
| [anomalyco/opentui](https://github.com/anomalyco/opentui)             | `da5507e1b3d637b946a12b71fb47d112b5d38393` | MIT, © 2025 opentui                              |

Assets, prompts, and themes from these repositories were considered separately and none were reused. Plannotator's VS Code subtree has an additional © 2025 7tg MIT notice; nothing from that subtree was reused.

## Distributed dependencies

Schlop directly depends on OpenTUI (`@opentui/core`, `@opentui/react`), Effect, React, and Zod through their published packages. Their own license files are distributed in their packages during source installation; production packaging must preserve notices required by the selected bundling/distribution mechanism. The Bun lockfile records exact resolved versions. OpenTUI is MIT-licensed as noted above. Effect, React, and Zod are MIT-licensed at the versions currently locked.

If future work copies or substantially adapts upstream material, update this file with the exact file, revision, copyright notice, license text, and modification record before distribution.
