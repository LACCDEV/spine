# Mitgelieferte Bibliotheken (unverändert)

| Ordner | Paket | Version | Lizenz | Quelle |
|---|---|---|---|---|
| `three/` | three.js (`build/three.module.js`, `build/three.core.js`) | 0.186.1 | MIT (`three/LICENSE`) | https://registry.npmjs.org/three/-/three-0.186.1.tgz |
| `mediapipe/` | @mediapipe/tasks-vision (`vision_bundle.mjs`, `wasm/vision_wasm_internal.*`, `wasm/vision_wasm_nosimd_internal.*`) | 0.10.35 | Apache-2.0 (`mediapipe/LICENSE`) | https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.35.tgz |

Warum MediaPipe 0.10.35 und nicht 1.x: Die Versionen 1.0.0 bis 1.1.1 enthalten einen
fest eingebauten Logger, der Nutzungsdaten an `https://odml.pa.googleapis.com/v1/log`
sendet. 0.10.35 enthält diesen Code nicht. Details in der Haupt-README.
