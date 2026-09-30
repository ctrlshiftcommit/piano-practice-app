/**
 * Score data and the deliberately small MusicXML/SVG pipeline used by the
 * practice screen. Parsed notes use quarter-note lengths for `beats`.
 */

export type PracticeNote = {
  midi: number;
  name: string;
  beats: number;
  measure: number;
};

export type Score = {
  id: string;
  title: string;
  composer: string;
  notes: PracticeNote[];
  timeSignature?: { beats: number; beatType: number };
};

const NATURAL_SEMITONES: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

const STEP_INDEX: Record<string, number> = {
  C: 0,
  D: 1,
  E: 2,
  F: 3,
  G: 4,
  A: 5,
  B: 6,
};

const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER = ["B", "E", "A", "D", "G", "C", "F"];

function localName(element: Element): string {
  return element.localName || element.tagName.split(":").pop() || element.tagName;
}

function childrenNamed(parent: Element, name: string): Element[] {
  const result: Element[] = [];
  for (let index = 0; index < parent.children.length; index += 1) {
    const child = parent.children.item(index);
    if (child && localName(child) === name) result.push(child);
  }
  return result;
}

function firstChild(parent: Element, name: string): Element | undefined {
  return childrenNamed(parent, name)[0];
}

function childText(parent: Element, name: string): string | undefined {
  const child = firstChild(parent, name);
  const value = child?.textContent?.trim();
  return value || undefined;
}

function allDescendants(parent: Element): Element[] {
  const result: Element[] = [];
  const visit = (element: Element): void => {
    for (let index = 0; index < element.children.length; index += 1) {
      const child = element.children.item(index);
      if (!child) continue;
      result.push(child);
      visit(child);
    }
  };
  visit(parent);
  return result;
}

function fail(message: string): never {
  throw new Error(message);
}

function parsePositiveInteger(value: string | undefined, label: string): number {
  if (!value || !/^\d+$/.test(value)) fail(`${label} must be a positive integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    fail(`${label} must be a positive integer.`);
  }
  return number;
}

function parseDuration(value: string | undefined, measure: number, noteNumber: number): number {
  if (!value || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
    fail(`Note ${noteNumber} in measure ${measure} has a missing or malformed duration.`);
  }
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) {
    fail(`Note ${noteNumber} in measure ${measure} must have a positive duration.`);
  }
  return duration;
}

function keyAlterations(key: Element): Map<string, number> {
  const fifthsText = childText(key, "fifths");
  if (fifthsText !== undefined) {
    if (!/^-?\d+$/.test(fifthsText)) fail("The key signature has malformed fifths data.");
    const fifths = Number(fifthsText);
    if (!Number.isInteger(fifths) || fifths < -7 || fifths > 7) {
      fail("Key signatures beyond seven sharps or flats are unsupported.");
    }
    const alterations = new Map<string, number>();
    const order = fifths >= 0 ? SHARP_ORDER : FLAT_ORDER;
    for (let index = 0; index < Math.abs(fifths); index += 1) {
      alterations.set(order[index], fifths >= 0 ? 1 : -1);
    }
    return alterations;
  }

  const steps = childrenNamed(key, "key-step");
  const alters = childrenNamed(key, "key-alter");
  if (steps.length !== alters.length) {
    fail("A custom key signature must pair every key-step with a key-alter.");
  }
  const alterations = new Map<string, number>();
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index].textContent?.trim().toUpperCase() || "";
    const alterText = alters[index].textContent?.trim() || "";
    if (!(step in STEP_INDEX) || !/^-?\d+$/.test(alterText)) {
      fail("The custom key signature contains an invalid step or alteration.");
    }
    const alter = Number(alterText);
    if (alter < -2 || alter > 2) fail("Custom key signatures with more than double accidentals are unsupported.");
    alterations.set(step, alter);
  }
  return alterations;
}

function accidentalAlteration(accidental: string): number | undefined {
  const values: Record<string, number> = {
    sharp: 1,
    flat: -1,
    natural: 0,
    "double-sharp": 2,
    "sharp-sharp": 2,
    "flat-flat": -2,
  };
  return values[accidental.trim().toLowerCase()];
}

function noteName(step: string, alter: number, octave: number): string {
  const accidental = alter === 0 ? "" : alter > 0 ? "#".repeat(alter) : "b".repeat(-alter);
  return `${step}${accidental}${octave}`;
}

function checkNoRepeats(root: Element): void {
  for (const element of allDescendants(root)) {
    const name = localName(element).toLowerCase();
    if (name === "repeat" || name === "ending" || name === "segno" || name === "coda") {
      fail("Repeats, endings, segno, and coda navigation are unsupported.");
    }
    if (name === "sound") {
      const navigationAttributes = [
        "dacapo",
        "da-capo",
        "dalsegno",
        "dal-segno",
        "tocoda",
        "to-coda",
        "fine",
        "segno",
        "coda",
      ];
      for (const attribute of navigationAttributes) {
        const value = element.getAttribute(attribute)?.trim().toLowerCase();
        if (value && value !== "no" && value !== "false" && value !== "0") {
          fail("Repeats and navigation instructions are unsupported.");
        }
      }
    }
  }
}

function parseMeter(time: Element): { beats: number; beatType: number } {
  const beatsText = childText(time, "beats");
  const beatTypeText = childText(time, "beat-type");
  if (!beatsText || !beatTypeText || !/^\d+$/.test(beatsText) || !/^\d+$/.test(beatTypeText)) {
    fail("The time signature is malformed; only 2/4, 3/4, and 4/4 are supported.");
  }
  const beats = Number(beatsText);
  const beatType = Number(beatTypeText);
  if (beatType !== 4 || ![2, 3, 4].includes(beats)) {
    fail(`The ${beatsText}/${beatTypeText} meter is unsupported; use 2/4, 3/4, or 4/4.`);
  }
  return { beats, beatType };
}

function validateClef(clef: Element): void {
  const sign = childText(clef, "sign")?.toUpperCase();
  const line = childText(clef, "line");
  if (sign && (sign !== "G" || (line !== undefined && line !== "2"))) {
    fail("Only treble clef (G clef on line 2) is supported.");
  }
  if (sign === "G" && line !== "2") fail("Only treble clef (G clef on line 2) is supported.");
  if (sign && sign !== "G") fail("Only treble clef (G clef on line 2) is supported.");
}

/** Parse the intentionally constrained, browser-side MusicXML subset. */
export function parseMusicXML(text: string): Score {
  if (typeof DOMParser === "undefined") {
    fail("MusicXML parsing requires a browser with DOMParser support.");
  }
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (
    document.documentElement?.localName === "parsererror" ||
    document.getElementsByTagName("parsererror").length > 0
  ) {
    fail("The MusicXML document is malformed.");
  }

  const root = document.documentElement;
  if (!root || localName(root) !== "score-partwise") {
    fail("Only partwise MusicXML scores are supported.");
  }
  checkNoRepeats(root);

  const parts = childrenNamed(root, "part");
  if (parts.length !== 1) {
    fail(`Exactly one MusicXML part is supported; found ${parts.length}.`);
  }
  const part = parts[0];
  const measures = childrenNamed(part, "measure");
  if (measures.length === 0) fail("The MusicXML score has no measures.");

  const partsWithVoices = allDescendants(part);
  if (partsWithVoices.some((element) => ["backup", "forward"].includes(localName(element)))) {
    fail("Backup and forward elements are unsupported because they can encode overlapping voices.");
  }

  const title =
    childText(firstChild(root, "work") || root, "work-title") ||
    childText(root, "movement-title") ||
    "Imported score";
  const identification = firstChild(root, "identification");
  const composer = identification
    ? childrenNamed(identification, "creator").find((creator) => creator.getAttribute("type")?.toLowerCase() === "composer")
        ?.textContent?.trim() || "Unknown composer"
    : "Unknown composer";

  let divisions: number | undefined;
  let keyMap = new Map<string, number>();
  let meter = { beats: 4, beatType: 4 };
  let scoreMeter = { ...meter };
  let hasExplicitMeter = false;
  let voiceId: string | undefined;
  let globalNoteNumber = 0;
  const notes: PracticeNote[] = [];

  for (let measureIndex = 0; measureIndex < measures.length; measureIndex += 1) {
    const measureElement = measures[measureIndex];
    const measureNumber = measureIndex + 1;
    const accidentalState = new Map<string, number>();
    let elapsedBeats = 0;
    let noteCount = 0;

    for (let childIndex = 0; childIndex < measureElement.children.length; childIndex += 1) {
      const child = measureElement.children.item(childIndex);
      if (!child) continue;
      const childKind = localName(child);
      if (childKind === "attributes") {
        const divisionsText = childText(child, "divisions");
        if (divisionsText !== undefined) {
          divisions = parsePositiveInteger(divisionsText, `Divisions in measure ${measureNumber}`);
        }
        const key = firstChild(child, "key");
        if (key) {
          keyMap = keyAlterations(key);
          accidentalState.clear();
        }
        const time = firstChild(child, "time");
        if (time) {
          const nextMeter = parseMeter(time);
          if (
            (globalNoteNumber > 0 && (nextMeter.beats !== scoreMeter.beats || nextMeter.beatType !== scoreMeter.beatType)) ||
            (hasExplicitMeter && (nextMeter.beats !== scoreMeter.beats || nextMeter.beatType !== scoreMeter.beatType))
          ) {
            fail("Changing time signatures within a score is unsupported.");
          }
          meter = nextMeter;
          scoreMeter = nextMeter;
          hasExplicitMeter = true;
        }
        for (const clef of childrenNamed(child, "clef")) validateClef(clef);
        continue;
      }
      if (childKind === "clef") {
        validateClef(child);
        continue;
      }
      if (childKind !== "note") continue;
      globalNoteNumber += 1;
      noteCount += 1;

      if (firstChild(child, "rest")) {
        fail(`Rests are unsupported (measure ${measureNumber}, note ${globalNoteNumber}).`);
      }
      if (firstChild(child, "chord")) {
        fail(`Chords are unsupported (measure ${measureNumber}, note ${globalNoteNumber}).`);
      }
      if (firstChild(child, "tie") || allDescendants(child).some((element) => localName(element) === "tied")) {
        fail(`Tied notes are unsupported (measure ${measureNumber}, note ${globalNoteNumber}).`);
      }
      if (firstChild(child, "grace")) {
        fail(`Grace notes are unsupported (measure ${measureNumber}, note ${globalNoteNumber}).`);
      }
      const noteStaff = childText(child, "staff");
      if (noteStaff && noteStaff !== "1") {
        fail(`Only a single treble staff is supported (measure ${measureNumber}, note ${globalNoteNumber}).`);
      }
      const currentVoice = childText(child, "voice") || "1";
      if (voiceId === undefined) voiceId = currentVoice;
      else if (voiceId !== currentVoice) {
        fail("Multiple voices are unsupported; use one voice throughout the score.");
      }

      const pitch = firstChild(child, "pitch");
      if (!pitch) fail(`Unpitched notes are unsupported (measure ${measureNumber}, note ${globalNoteNumber}).`);
      const step = childText(pitch, "step")?.toUpperCase() || "";
      const octaveText = childText(pitch, "octave");
      if (!(step in STEP_INDEX) || !octaveText || !/^-?\d+$/.test(octaveText)) {
        fail(`Note ${globalNoteNumber} in measure ${measureNumber} has an invalid pitch.`);
      }
      const octave = Number(octaveText);

      const pitchAlterText = childText(pitch, "alter");
      const accidentalText = childText(child, "accidental");
      let explicitAlter: number | undefined;
      if (pitchAlterText !== undefined) {
        if (!/^-?\d+(?:\.\d+)?$/.test(pitchAlterText)) {
          fail(`Note ${globalNoteNumber} in measure ${measureNumber} has a malformed pitch alteration.`);
        }
        explicitAlter = Number(pitchAlterText);
      } else if (accidentalText !== undefined) {
        explicitAlter = accidentalAlteration(accidentalText);
        if (explicitAlter === undefined) {
          fail(`Accidental “${accidentalText}” is unsupported (measure ${measureNumber}, note ${globalNoteNumber}).`);
        }
      }
      if (explicitAlter !== undefined && (!Number.isInteger(explicitAlter) || explicitAlter < -2 || explicitAlter > 2)) {
        fail(`Microtonal or more-than-double alterations are unsupported (measure ${measureNumber}, note ${globalNoteNumber}).`);
      }

      const accidentalKey = `${step}${octave}`;
      const alter = explicitAlter ?? accidentalState.get(accidentalKey) ?? keyMap.get(step) ?? 0;
      if (explicitAlter !== undefined) accidentalState.set(accidentalKey, explicitAlter);
      const midi = 12 * (octave + 1) + NATURAL_SEMITONES[step] + alter;
      if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
        fail(`Note ${globalNoteNumber} in measure ${measureNumber} is outside the MIDI note range.`);
      }

      if (divisions === undefined) {
        fail(`A positive <divisions> value is required before notes in measure ${measureNumber}.`);
      }
      const durationValue = parseDuration(childText(child, "duration"), measureNumber, globalNoteNumber);
      const beats = (durationValue * 4) / (divisions * meter.beatType);
      if (!Number.isFinite(beats) || beats <= 0) {
        fail(`Note ${globalNoteNumber} in measure ${measureNumber} has an invalid duration.`);
      }
      elapsedBeats += beats;
      if (elapsedBeats > meter.beats + 1e-6) {
        fail(`Measure ${measureNumber} exceeds its ${meter.beats}/${meter.beatType} time signature.`);
      }
      notes.push({ midi, name: noteName(step, alter, octave), beats, measure: measureNumber });
    }

    if (noteCount === 0) {
      fail(`Measure ${measureNumber} contains no notes; empty measures and rests are unsupported.`);
    }
  }

  if (notes.length === 0) fail("The MusicXML score contains no playable notes.");
  return {
    id: crypto.randomUUID(),
    title,
    composer,
    notes,
    timeSignature: scoreMeter,
  };
}

function midiName(midi: number): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const pitch = ((Math.round(midi) % 12) + 12) % 12;
  return `${names[pitch]}${Math.floor(Math.round(midi) / 12) - 1}`;
}

function notePosition(name: string, midi: number): { diatonic: number; accidental: string } {
  const match = /^([A-G])([#b]{0,2})(-?\d+)$/.exec(name);
  if (!match) {
    const fallback = midiName(midi);
    return notePosition(fallback, midi);
  }
  const step = match[1];
  const accidental = match[2];
  const octave = Number(match[3]);
  return {
    diatonic: octave * 7 + STEP_INDEX[step],
    accidental,
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function engravingDuration(beats: number): { hollow: boolean; stem: boolean; flags: number; dots: number } {
  const bases = [4, 2, 1, 0.5, 0.25, 0.125, 0.0625];
  let best = { base: 1, dots: 0, error: Number.POSITIVE_INFINITY };
  for (const base of bases) {
    for (let dots = 0; dots <= 2; dots += 1) {
      const value = base * (2 - 1 / 2 ** dots);
      const error = Math.abs(value - beats);
      if (error < best.error) best = { base, dots, error };
    }
  }
  let base = best.base;
  let dots = best.dots;
  if (best.error > 0.001) {
    base = bases.reduce((closest, candidate) =>
      Math.abs(Math.log2(candidate / beats)) < Math.abs(Math.log2(closest / beats)) ? candidate : closest,
    );
    dots = 0;
  }
  const flags = base < 1 ? Math.max(1, Math.round(Math.log2(1 / base))) : 0;
  return {
    hollow: base >= 2,
    stem: base < 4,
    flags,
    dots,
  };
}

function staffY(diatonic: number, bottomLine: number): number {
  const e4 = 4 * 7 + STEP_INDEX.E;
  return bottomLine - (diatonic - e4) * 8;
}

function renderSystem(
  score: Score,
  indexedNotes: Array<{ note: PracticeNote; index: number }>,
  labels: boolean,
  showOctaves: boolean,
  viewBoxWidth: number,
): string {
  const noteData = indexedNotes.map(({ note, index }) => ({
    note,
    index,
    position: notePosition(note.name, note.midi),
  }));
  const e4 = 4 * 7 + STEP_INDEX.E;
  const relativeYs = noteData.map(({ position }) => -(position.diatonic - e4) * 8);
  const minimumRelativeY = relativeYs.length ? Math.min(...relativeYs) : 0;
  const maximumRelativeY = relativeYs.length ? Math.max(...relativeYs) : 0;
  const bottomLine = Math.max(114, 30 - minimumRelativeY);
  const staffTop = bottomLine - 64;
  const maxNoteY = bottomLine + maximumRelativeY;
  const labelY = Math.max(bottomLine + 94, maxNoteY + 25);
  const height = Math.ceil(Math.max(200, labelY + 20));
  const compact = viewBoxWidth <= 500;
  // The staff begins beneath the clef so its G loop sits on the second line.
  const left = compact ? 0 : 20;
  const right = viewBoxWidth - (compact ? 16 : 38);
  const firstX = compact ? 91 : 126;
  const noteGap = compact
    ? Math.min(72, (right - firstX - 22) / Math.max(1, noteData.length - 1))
    : 46;
  const positions = noteData.map((item, itemIndex) => ({
    ...item,
    x: firstX + itemIndex * noteGap,
    y: staffY(item.position.diatonic, bottomLine),
  }));
  const staffLines = Array.from({ length: 5 }, (_, lineIndex) => {
    const y = staffTop + lineIndex * 16;
    return `<line class="staff-line" x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="currentColor" stroke-width="1.4" />`;
  }).join("");

  const noteMarkup = positions
    .map(({ note, index, x, y, position }) => {
      const duration = engravingDuration(note.beats);
      const noteLedgerYs: number[] = [];
      for (let ledgerY = bottomLine + 16; ledgerY <= y + 0.1; ledgerY += 16) noteLedgerYs.push(ledgerY);
      for (let ledgerY = staffTop - 16; ledgerY >= y - 0.1; ledgerY -= 16) noteLedgerYs.push(ledgerY);
      const ledgerMarkup = noteLedgerYs
        .map((ledgerY) => `<line class="ledger-line" x1="${x - 13}" y1="${ledgerY}" x2="${x + 13}" y2="${ledgerY}" stroke="currentColor" stroke-width="1.3" />`)
        .join("");
      const stemDown = position.diatonic >= 4 * 7 + STEP_INDEX.B;
      const stemX = stemDown ? x - 7 : x + 7;
      const stemEndY = y + (stemDown ? 35 : -35);
      const stem = duration.stem
        ? `<line class="note-stem" x1="${stemX}" y1="${y}" x2="${stemX}" y2="${stemEndY}" stroke="currentColor" stroke-width="2.2" />`
        : "";
      const flags = Array.from({ length: duration.flags }, (_, flagIndex) => {
        const offset = flagIndex * (stemDown ? -8 : 8);
        const path = stemDown
          ? `M ${stemX} ${stemEndY + offset} C ${stemX - 16} ${stemEndY + offset + 4} ${stemX - 17} ${stemEndY + offset + 14} ${stemX - 8} ${stemEndY + offset + 21}`
          : `M ${stemX} ${stemEndY + offset} C ${stemX + 16} ${stemEndY + offset + 4} ${stemX + 17} ${stemEndY + offset + 14} ${stemX + 8} ${stemEndY + offset + 21}`;
        return `<path class="note-flag" d="${path}" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" />`;
      }).join("");
      const accidental = position.accidental
        ? position.accidental.includes("#")
          ? "♯".repeat(position.accidental.length)
          : "♭".repeat(position.accidental.length)
        : "";
      const accidentalMarkup = accidental
        ? `<text class="note-accidental" x="${x - 20}" y="${y + 6}" text-anchor="end">${accidental}</text>`
        : "";
      const dots = Array.from({ length: duration.dots }, (_, dotIndex) => {
        const dotX = x + 14 + dotIndex * 8;
        return `<circle class="note-dot" cx="${dotX}" cy="${y - 1}" r="2.2" fill="currentColor" />`;
      }).join("");
      const labelMarkup = labels
        ? `<text class="note-label" x="${x}" y="${labelY}" text-anchor="middle" fill="currentColor">${escapeXml(showOctaves ? note.name : note.name.replace(/-?\d+$/, ""))}</text>`
        : "";
      const ariaLabel = `${note.name}, ${note.beats} beats, measure ${note.measure}`;
      return `<g class="score-note" data-note="${index}" data-duration="${note.beats}" tabindex="0" role="button" aria-label="${escapeXml(ariaLabel)}" style="cursor:pointer">${accidentalMarkup}${ledgerMarkup}<ellipse class="notehead${duration.hollow ? " notehead-hollow" : ""}" cx="${x}" cy="${y}" rx="9" ry="6" transform="rotate(-20 ${x} ${y})" fill="${duration.hollow ? "none" : "currentColor"}" stroke="currentColor" stroke-width="1.6" />${stem}${flags}${dots}${labelMarkup}<ellipse class="note-overlay" data-overlay="${index}" cx="${x}" cy="${y}" rx="13" ry="10" fill="transparent" pointer-events="all" /></g>`;
    })
    .join("");

  const barlines = positions
    .map((item, positionIndex) => {
      const next = score.notes[item.index + 1];
      if (next && next.measure === item.note.measure) return "";
      const x = Math.min(right, item.x + noteGap / 2);
      return `<line class="barline" x1="${x}" y1="${staffTop}" x2="${x}" y2="${bottomLine}" stroke="currentColor" stroke-width="1.4" />`;
    })
    .join("");
  const title = `${score.title || "Practice score"} — treble staff`;
  const timeSignature = score.timeSignature || { beats: 4, beatType: 4 };
  const timeSignatureX = compact ? 57 : 76;
  const timeDigit = (value: number): string => String.fromCodePoint(0xe080 + value);
  const timeSignatureMarkup = `<g class="time-signature" font-size="64" fill="currentColor" aria-label="${timeSignature.beats}/${timeSignature.beatType}"><text x="${timeSignatureX}" y="${staffTop + 16}" text-anchor="middle">${timeDigit(timeSignature.beats)}</text><text x="${timeSignatureX}" y="${staffTop + 48}" text-anchor="middle">${timeDigit(timeSignature.beatType)}</text></g>`;
  const clef = String.fromCodePoint(0xe050);
  // Bravura's G-clef origin is the G line, one staff space above the bottom.
  const clefY = bottomLine - 16;

  return `<svg xmlns="http://www.w3.org/2000/svg" class="score-system" viewBox="0 0 ${viewBoxWidth} ${height}" role="group" aria-label="${escapeXml(title)}"><g class="staff">${staffLines}<text class="clef" x="${left}" y="${clefY}" font-size="64" fill="currentColor">${clef}</text>${timeSignatureMarkup}${barlines}${noteMarkup}</g></svg>`;
}

/** Render a score as accessible, clickable treble-staff SVG systems. */
export function renderScore(score: Score, labels: boolean, showOctaves = false, availableWidth = 900): string {
  const compact = availableWidth <= 500;
  const viewBoxWidth = compact ? Math.max(320, Math.floor(availableWidth)) : 900;
  const notesPerSystem = compact ? 8 : 15;
  const systems: Array<Array<{ note: PracticeNote; index: number }>> = [];
  let measureNotes: Array<{ note: PracticeNote; index: number }> = [];
  const flushMeasure = (): void => {
    if (measureNotes.length === 0) return;
    if (compact) {
      for (let start = 0; start < measureNotes.length; start += notesPerSystem) {
        systems.push(measureNotes.slice(start, start + notesPerSystem));
      }
    } else if (measureNotes.length > notesPerSystem) {
      for (let start = 0; start < measureNotes.length; start += notesPerSystem) {
        systems.push(measureNotes.slice(start, start + notesPerSystem));
      }
    } else if (systems.length > 0 && systems[systems.length - 1].length + measureNotes.length <= notesPerSystem) {
      systems[systems.length - 1].push(...measureNotes);
    } else {
      systems.push(measureNotes);
    }
    measureNotes = [];
  };

  let currentMeasure: number | undefined;
  for (let index = 0; index < score.notes.length; index += 1) {
    const note = score.notes[index];
    if (currentMeasure !== undefined && currentMeasure !== note.measure) flushMeasure();
    currentMeasure = note.measure;
    measureNotes.push({ note, index });
  }
  flushMeasure();
  if (systems.length === 0) systems.push([]);
  return systems.map((system) => renderSystem(score, system, labels, showOctaves, viewBoxWidth)).join("");
}

function demoNote(name: string, beats: number, measure: number): PracticeNote {
  const match = /^([A-G])(-?\d+)$/.exec(name);
  if (!match) throw new Error(`Invalid built-in note: ${name}`);
  return {
    midi: 12 * (Number(match[2]) + 1) + NATURAL_SEMITONES[match[1]],
    name,
    beats,
    measure,
  };
}

function demoFromBars(id: string, title: string, bars: Array<Array<[string, number]>>): Score {
  return {
    id,
    title,
    composer: "Original exercise",
    timeSignature: { beats: 4, beatType: 4 },
    notes: bars.flatMap((bar, barIndex) => bar.map(([name, beats]) => demoNote(name, beats, barIndex + 1))),
  };
}

/** Two original, C-major exercises with 32 and 36 playable notes. */
export const demos: Score[] = [
  demoFromBars("c-major-steps", "C Major Steps", [
    [["C4", 1], ["D4", 1], ["E4", 1], ["F4", 1]],
    [["G4", 1], ["A4", 1], ["G4", 1], ["E4", 1]],
    [["F4", 1], ["E4", 1], ["D4", 1], ["C4", 1]],
    [["D4", 1], ["E4", 1], ["F4", 1], ["D4", 1]],
    [["E4", 1], ["F4", 1], ["G4", 1], ["E4", 1]],
    [["D4", 1], ["G4", 1], ["E4", 1], ["C4", 1]],
    [["C4", 1], ["E4", 1], ["G4", 1], ["C5", 1]],
    [["G4", 1], ["E4", 1], ["D4", 1], ["C4", 1]],
  ]),
  demoFromBars("c-major-rhythm", "C Major Rhythm", [
    [["C4", 0.5], ["D4", 0.5], ["E4", 1], ["G4", 1], ["E4", 1]],
    [["D4", 0.5], ["E4", 0.5], ["F4", 1], ["A4", 1], ["G4", 1]],
    [["E4", 1], ["G4", 0.5], ["A4", 0.5], ["G4", 1], ["E4", 1]],
    [["D4", 1], ["F4", 0.5], ["E4", 0.5], ["D4", 1], ["C4", 1]],
    [["G4", 0.5], ["A4", 0.5], ["G4", 1], ["E4", 1], ["D4", 1]],
    [["C4", 1], ["E4", 1], ["G4", 1], ["E4", 1]],
    [["F4", 1], ["D4", 1], ["E4", 1], ["C4", 1]],
    [["D4", 0.5], ["E4", 0.5], ["C4", 3]],
  ]),
];
