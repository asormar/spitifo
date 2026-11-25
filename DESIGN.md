---
name: spitifo
description: Your own music, found, verified and played in one app that moves.
colors:
  ground: "#f5f5fa"
  surface: "#ffffff"
  surface-2: "#ebebf3"
  surface-3: "#d8d8e6"
  ink: "#11111c"
  ink-muted: "#585870"
  ink-dim: "#66667e"
  action-cobalt: "#3045ff"
  sound-pink: "#ff4fa3"
  sound-pink-tint: "#ffe0ef"
  verdict-match: "#0f7442"
  verdict-near: "#8d5c00"
  verdict-miss: "#c8323b"
  ground-dark: "#0e0e18"
  surface-dark: "#181826"
  surface-2-dark: "#232336"
  surface-3-dark: "#34344c"
  ink-dark: "#f3f3fb"
  action-cobalt-dark: "#8592ff"
  sound-pink-dark: "#ff7ec0"
typography:
  display-xl:
    fontFamily: "Unbounded Variable, system-ui, sans-serif"
    fontSize: "44px"
    fontWeight: 800
    lineHeight: 1.02
    letterSpacing: "-0.02em"
  display:
    fontFamily: "Unbounded Variable, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "Unbounded Variable, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Unbounded Variable, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.2
  body:
    fontFamily: "Onest Variable, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1.4
  ui:
    fontFamily: "Onest Variable, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1.2
  caption:
    fontFamily: "Onest Variable, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.35
  label:
    fontFamily: "Onest Variable, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.01em"
  micro:
    fontFamily: "Onest Variable, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.2
rounded:
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "30px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
  "12": "48px"
components:
  button-primary:
    backgroundColor: "{colors.action-cobalt}"
    textColor: "{colors.surface}"
    typography: "{typography.ui}"
    rounded: "{rounded.pill}"
    padding: "0 20px"
    height: "48px"
  button-play:
    backgroundColor: "{colors.sound-pink}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    size: "48px"
  button-soft:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.pill}"
    padding: "0 20px"
    height: "48px"
  button-ghost:
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    size: "48px"
  song-row:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "8px"
    height: "64px"
  menu-item:
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "48px"
  chip-verdict:
    typography: "{typography.micro}"
    rounded: "{rounded.pill}"
    padding: "5px 8px"
  tab-bar-item:
    textColor: "{colors.ink-muted}"
    typography: "{typography.micro}"
    height: "56px"
---

# Design System: spitifo

## Overview

**Creative North Star: "Giro"**

spitifo is a music app that moves. The record turns while it plays, lists arrive in a short cascade, sheets and the player follow the finger and settle with weight. Motion is the signature: it is the one place where the app already beats Spotify, so every screen earns its personality by how it moves, never by unfamiliar structure. The structure itself follows Spotify, Apple Music and YouTube Music on purpose; a person who knows those apps knows where everything is.

The surfaces are flat, light-first and quiet, so the motion and the cover art carry the energy. Two colours act, each with one meaning: pink is sound, cobalt is everything you do. Verification (does this file really match what you asked for?) is shown in plain words on every row, because truth over convenience is the product's first principle.

Speed is part of the look. Motion that drops frames on a mid-range Android phone is a defect, not a style.

**Key Characteristics:**
- Motion is the signature: a turning record, cascading entrances, gestures that track the finger.
- Pink means sound, cobalt means action; never the other way round.
- Flat surfaces with soft shadows, light and dark themes with the same token names.
- Unbounded for headings and numbers, Onest for everything people read and press.
- One icon family (Phosphor): regular at rest, fill when active.
- Familiar music-app structure; personality lives in colour, type, motion and the verdicts.

## Colors

A cool, near-neutral ground with two saturated voices that never share a job.

### Primary
- **Action Cobalt** (#3045ff light, #8592ff dark): primary buttons, the active tab, links, selection, focus rings and progress of non-audio work (downloads). It answers "what can I do here".

### Secondary
- **Sound Pink** (#ff4fa3 light, #ff7ec0 dark): the play button, what is playing now (the equaliser bars, the turning record's label, the playback progress line), and the heart that saves a song. Text and glyphs on pink are always ink (#11111c), never white. **Sound Pink Tint** (#ffe0ef light, #3a2032 dark) backs the row that is playing.

### Tertiary
- **Verdict colours**: match green (#0f7442), near amber (#8d5c00), miss red (#c8323b), each with a 15 % tint behind its text. They are state, not accent, and keep their meaning in both themes.

### Neutral
- **Ground** (#f5f5fa / #0e0e18): the page floor.
- **Surface 1-3** (#ffffff, #ebebf3, #d8d8e6 / #181826, #232336, #34344c): cards and rows, chips and soft buttons, tracks and rings.
- **Ink** (#11111c / #f3f3fb), **Ink Muted** (#585870 / #a7a7bf), **Ink Dim** (#66667e / #8e8ea7): text in three steps. Muted and dim stay at or above 4.5:1 on ground, surface 1 and surface 2 in both themes; `tokens.test.js` enforces it.

### Named Rules
**The Sound Is Pink Rule.** Pink appears only where audio is involved: play, playing, playback progress, the heart. A pink download button, a pink tab or a pink link is a bug.

**The Cobalt Does Rule.** Every other accent is cobalt. If an element is not about sound and needs emphasis, it is cobalt or it is ink.

**The Token-Only Rule.** Component CSS never contains a raw hex or rgba value. The fixed dark Now Playing treatment derives its colours from the theme tokens with `color-mix()`; it does not redefine them with literals.

## Typography

**Display Font:** Unbounded Variable (with system-ui, sans-serif)
**Body Font:** Onest Variable (with system-ui, sans-serif)

**Character:** Unbounded is wide, round and loud, like a record label; it is used sparingly for titles and numbers. Onest is a calm, slightly humanist grotesque that keeps lists and menus easy to scan.

### Hierarchy
- **Display XL** (Unbounded 800, 44px, 1.02): the Now Playing title on PC and the album/artist hero on PC.
- **Display** (Unbounded 700, 28px, 1.08): album, artist and playlist titles on the phone; screen titles on PC.
- **Headline** (Unbounded 700, 22px, 1.15): screen titles on the phone (Inicio, Tu biblioteca, Buscar).
- **Title** (Unbounded 700, 18px, 1.2): section headings (shelves, groups) and card titles.
- **Body** (Onest 500, 15px, 1.4): song titles in rows (at 700), paragraphs, sheet text. Paragraphs stop at 65ch.
- **UI** (Onest 700, 14px, 1.2): buttons, menu items, inputs, tabs on PC.
- **Caption** (Onest 500, 13px, 1.35): row metadata (artist · album · year), secondary lines, helper text.
- **Label** (Onest 700, 12px, 1.2): chips, filter pills, small headers.
- **Micro** (Onest 700, 11px, 1.2): verdict and source badges, tab bar labels, timestamps. Nothing is ever smaller than 11px.

### Named Rules
**The Nine Sizes Rule.** Only the nine sizes above exist. No half pixels (12.5, 13.5, 14.5) and no one-off sizes; a new need maps to the nearest step.

**The Loud Face Rule.** Unbounded never sets running text, buttons or metadata, and never more than one Unbounded line competes on a screen region.

## Layout

The phone is the primary layout: a single column with a side gutter of `clamp(16px, 4.4vw, 56px)`, a bottom tab bar and the mini-player above it. At 960px and wider the app becomes a PC layout: a left navigation rail, the main column, and a right panel for Now Playing and the queue. The content column uses the full width up to 1600px; grids pick their column count from the available width instead of fixed counts.

Spacing uses one 4px-based scale: 4, 8, 12, 16, 20, 24, 32, 40, 48 (`--sp-1` to `--sp-12`). Inside a row the gap is 12px; between rows 8px; between sections 32px on the phone and 40px on PC.

Breakpoints: 960px (PC) and 1280px (wide PC). They are defined once and shared by CSS and JS; no stylesheet writes the number by hand.

Touch targets are at least 48px in both directions on the phone, even when the visible shape is smaller.

### Named Rules
**The Scale-Only Rule.** Every gap, padding and margin is a spacing token. A literal px spacing in component CSS is a bug.

## Elevation & Depth

Flat surfaces separated by tone, with two soft shadows for things that float. Cards and rows sit on the ground with no shadow or the small one; the mini-player, sheets, menus and toasts use the large one. Depth also comes from motion: what floats moves, what sits still is part of the page.

### Shadow Vocabulary
- **Small** (`0 2px 8px rgba(30, 30, 80, 0.16)` light, `0 2px 8px rgba(0, 0, 0, 0.4)` dark): cards that can be pressed, the tab bar.
- **Large** (`0 10px 30px rgba(30, 30, 80, 0.13)` light, `0 10px 30px rgba(0, 0, 0, 0.45)` dark): the mini-player, sheets, menus, popovers, toasts.

### Named Rules
**The No-Blur-Over-Scroll Rule.** Nothing fixed over a scrolling list uses `backdrop-filter` on Android; the mini-player and bars use the solid glass colour instead. Blur is allowed only on surfaces that do not sit over scrolling content.

## Shapes

Soft, generous corners on one short scale: 12px (small covers, thumbnails), 16px (rows, menus, chips that are not pills, inner cards), 24px (cards, sheets, the mini-player), 30px (large panels and the phone sheet top), and full pills for buttons, fields and badges. Circles are `50%`. Edges are drawn with inner rings (`inset 0 0 0 1.5px var(--s3)`) rather than borders.

The record is the recurring silhouette: a black disc with a pink label, used in the logo, in the mini-player while music plays, and peeking from covers in the player. It is a motif, never wallpaper.

## Components

### Buttons
Tactile and quick: everything presses in and springs back.
- **Shape:** full pill (999px); icon buttons are circles.
- **Primary:** cobalt background, white text (dark theme: ink text on light cobalt), UI type, 48px high, 0 20px padding.
- **Play:** pink circle, ink glyph, 48px (64px in Now Playing). The only pink button.
- **Soft:** surface 2 background, ink text; secondary actions next to a primary.
- **Ghost:** no background, ink glyph; toolbars and row actions. Hover shows the hover tint.
- **Danger:** miss red text on its tint; destructive confirmations only.
- **Press:** `scale(0.97)` over 150ms, back over 180ms with the standard curve. Rows press to `scale(0.98)`.

### Chips
- **Verdict chips:** micro type, pill, verdict colour on its tint: «Coincide», «Parecido», «Solo 30 s», «No coincide», «Sin verificar» (muted on surface 2).
- **Filter chips:** label type, pill, surface 2 at rest, cobalt with its ink when selected.

### Cards / Containers
- **Corner Style:** 24px for cards and sheets, 16px for inner blocks.
- **Background:** surface 1 on the ground; surface 2 for nested blocks.
- **Shadow Strategy:** small when pressable, large when floating (see Elevation).
- **Internal Padding:** 16px on the phone, 20-24px on PC.

### Inputs / Fields
- **Style:** pill, surface 1 with the inner ring, 48px high, body type.
- **Focus:** a 2px cobalt ring outside the inner ring.
- **Error:** miss red helper text below the field, in caption type.

### Navigation
- **Phone:** bottom tab bar with four tabs (Inicio, Buscar, Tu biblioteca, Descubrir); icons are Phosphor regular, the active one is fill and cobalt, labels in micro type. The active tab never loses its label.
- **PC:** a left rail with the same four destinations and the playlists, collapsible to icons; the right panel holds Now Playing and the queue.

### Song Row
One row for every list of songs (library, search, album, playlist, queue): 64px high on the phone and 56px in PC tables, 48px cover at 12px radius, 12px gap, title in body 700, metadata in caption muted, verdict chip when the file has one, and one trailing slot whose content depends on the context (more menu, download, drag handle). The playing row gets the pink tint and the equaliser bars. A tap anywhere plays; the trailing slot never plays.

### Menu
One menu surface for every context menu and sheet list: rows 48px high, 16px radius, 12px gap, 0 14px padding, UI type, 20px icons; arrows, Home, End and Escape work everywhere; it opens with the drawer curve and closes with the same motion reversed.

### Icons
Phosphor everywhere, through one component. Regular weight at rest, fill when active, selected or playing. Four sizes: 16, 20, 24 and 32px. No other icon source and no hand-drawn SVG, except the Disco logo.

### The Turning Record (signature)
While music plays, the mini-player shows the cover as a record that turns once every 3.2 seconds; it stops, without snapping back, when playback pauses. Under reduced motion it stays still.

### Motion
- **Tokens:** press 150ms, quick 180ms (hover, colour, every exit), enter 240ms, move 360ms, scene 550ms; the standard curve `cubic-bezier(0.23, 1, 0.32, 1)`, the drawer curve `cubic-bezier(0.32, 0.72, 0, 1)` for sheets and panels, and the spring curve only for completion moments (a download finished, a heart filled).
- **Gestures:** the player, sheets and the mode swipe follow the finger 1:1 and release with velocity; a release faster than 0.5 px/ms or past 35 % of the distance completes, anything else springs back.
- **Entrances:** lists cascade 30ms per row for the first eight rows, once per screen visit.
- **Exits:** everything that enters with motion also leaves with motion, at the quick duration.
- **Reduced motion:** CSS and JS both drop to instant; no code waits for an animation that did not run.

## Do's and Don'ts

### Do:
- **Do** animate only `transform` and `opacity`, and keep every animation interruptible.
- **Do** use pink only for sound (play, playing, playback progress, heart) and cobalt for every other accent.
- **Do** set every size, gap, radius, duration and colour from a token.
- **Do** keep touch targets at 48px or more on the phone.
- **Do** show the verdict in words on every row that has one.
- **Do** test every motion on a mid-range Android profile before calling it done.

### Don't:
- **Don't** use a font size outside the nine steps, or anything below 11px.
- **Don't** put white text on pink.
- **Don't** add a second icon family or draw an icon by hand.
- **Don't** use `backdrop-filter` on anything fixed over a scrolling list.
- **Don't** write the 960px breakpoint, a hex colour or a px spacing literal in component CSS.
- **Don't** invent a structure people do not already know from leading music apps.
