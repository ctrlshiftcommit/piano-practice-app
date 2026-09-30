# Piano Practice App

An open-source web app for practicing piano with microphone pitch detection, sheet music, note feedback and tempo tracking.

## Run locally

Requires Node.js 22.12 or newer. Node.js 24 is used for development.

```sh
npm ci
npm run dev
```

Open the localhost address printed by Vite and allow microphone access. `npm run build` typechecks and creates a production build in `dist/`.

## Practice

- **Play through** advances after each confirmed key press, including mistakes. **Learn** waits for the correct note.
- Correct and incorrect notes receive translucent overlays. Colors, opacity, note names, octave numbers and appearance are configurable.
- Set a target BPM to compare your played tempo. Tempo tracking uses the written note lengths; long pauses reset the estimate.
- The score follows your position automatically. Manual scrolling pauses following; choose **Resume following** to resume.
- Choose the microphone input in Settings. The default tuning reference is A4 = 440 Hz; change it only if your instrument uses a different reference. A live frequency reading helps diagnose input or tuning problems.
- Click a note to practice from that position. **Keyboard demo** and the A–L keys let you try the interface without microphone input; they do not generate piano audio.

## Import

Import `.xml` or `.musicxml` files containing a single treble-clef melody. The supported subset includes natural/sharp/flat pitches, key signatures, and quarter/half/whole notes in 2/4, 3/4 or 4/4. Unsupported notation is rejected with an error instead of silently changing the score. Compressed `.mxl` files are not supported.

**PDF recognition is not implemented.** A future importer needs optical music recognition and a review step. The current app does not convert uploaded PDFs.

## Current limits and privacy

Microphone practice supports one note at a time, from C2 to C7. Chords, sustain pedal, room noise and very quiet overlapping notes can affect detection. The detector checks harmonic periods, waits through the attack transient, and leaves uncertain sound unscored. Simulated piano recordings and injected browser audio are checked, but accuracy on a particular physical piano still needs validation.

Microphone audio is processed locally in the browser; it is not recorded or uploaded. Imported scores and preferences stay in browser storage. Clearing browser data removes them. Microphone access requires localhost or HTTPS.

Full two-hand notation, polyphonic detection, PDF import, score editing, loops and a metronome are not implemented.

## Development

React, TypeScript and Vite. `src/score.ts` handles the constrained MusicXML parser and SVG notation. `src/pitch.ts` and `src/pitch-samples.ts` handle pitch estimation, onset tracking and sample filtering. `src/audio.ts` connects microphone capture; `src/main.tsx` handles practice state and controls.

## License

Application code is released under the [MIT License](LICENSE). The bundled Bravura notation font is licensed separately under the [SIL Open Font License](src/assets/Bravura-LICENSE.txt). Other dependencies retain their own licenses.
