// The Distinct guard, drawn as inline SVG so its colors follow the light/dark theme
// (every color is a CSS variable defined in web.ts).

export const GUARD_SVG = `<svg class="guard-art" viewBox="0 0 260 470" role="img" aria-label="Distinct security guard">
  <!-- gate barrier and fence behind him -->
  <g class="g-scene">
    <rect x="6" y="300" width="20" height="62" rx="4" class="g-post"/>
    <path d="M24 318 L96 312 L96 324 L24 330 Z" class="g-bar"/>
    <path d="M38 317 l8 -1 l-4 13 l-8 1 z M62 315 l8 -1 l-4 13 l-8 1 z M84 313 l8 -1 l-2 12 l-8 1 z" class="g-bar-stripe"/>
    <path d="M196 236 V372" class="g-line" stroke-width="3"/>
    <path d="M196 240 H254 V372 H196" class="g-fence"/>
    <path d="M196 252 l58 58 M196 282 l58 58 M196 312 l58 58 M196 342 l30 30 M214 240 l40 40 M234 240 l20 20 M254 252 l-58 58 M254 282 l-58 58 M254 312 l-58 58 M254 342 l-30 30 M234 240 l-38 38 M214 240 l-18 18" class="g-mesh"/>
    <rect x="203" y="262" width="44" height="22" rx="2" class="g-sign"/>
    <path d="M209 270 h32 M209 277 h24" class="g-sign-text"/>
  </g>
  <!-- shadow -->
  <ellipse cx="130" cy="452" rx="84" ry="10" class="g-shadow"/>
  <!-- legs -->
  <path d="M130 268 L84 440 L66 444 M130 268 L176 440 L196 444" class="g-line" stroke-width="5" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
  <!-- body -->
  <path d="M130 150 V270" class="g-line" stroke-width="5" stroke-linecap="round"/>
  <!-- arms, hands on hips -->
  <path d="M130 170 L74 214 L112 250 M130 170 L186 214 L148 250" class="g-line" stroke-width="5" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
  <!-- chest badge -->
  <path d="M140 180 h22 v12 q0 10 -11 15 q-11 -5 -11 -15 z" class="g-cap"/>
  <path d="M145 188 h12 M146 194 h10" class="g-badge-text"/>
  <!-- duty belt: radio, buckle, flashlight, baton -->
  <rect x="102" y="246" width="56" height="9" rx="2" class="g-gear"/>
  <rect x="124" y="244" width="12" height="13" rx="2" class="g-buckle"/>
  <path d="M96 228 v-14" class="g-line" stroke-width="2.5" stroke-linecap="round"/>
  <rect x="88" y="228" width="16" height="30" rx="3" class="g-radio"/>
  <rect x="92" y="233" width="8" height="8" rx="1" class="g-screen"/>
  <rect x="150" y="252" width="10" height="34" rx="3" class="g-gear"/>
  <rect x="149" y="282" width="12" height="6" rx="2" class="g-light"/>
  <path d="M166 246 L178 312" class="g-baton" stroke-width="9" stroke-linecap="round"/>
  <!-- head -->
  <circle cx="130" cy="104" r="44" class="g-head"/>
  <!-- sunglasses -->
  <path d="M86 102 h88" class="g-line" stroke-width="2.5"/>
  <path d="M92 100 q0 18 17 18 q15 0 16 -18 z" class="g-glass"/>
  <path d="M135 100 q1 18 16 18 q17 0 17 -18 z" class="g-glass"/>
  <path d="M99 106 l10 -4 M142 106 l10 -4" class="g-glint" stroke-width="2.5" stroke-linecap="round"/>
  <!-- smile -->
  <path d="M116 128 q14 9 28 -2" fill="none" class="g-line" stroke-width="3" stroke-linecap="round"/>
  <!-- police cap -->
  <path d="M80 70 Q130 22 182 66 L176 84 H86 Z" class="g-cap"/>
  <path d="M84 84 H178 Q174 96 130 97 Q88 96 84 84 Z" class="g-cap2"/>
  <circle cx="176" cy="82" r="3" class="g-badge"/>
  <path d="M130 46 l7 4 l-1.5 8 l-5.5 4 l-5.5 -4 l-1.5 -8 z" class="g-badge"/>
</svg>`;

export const MARK_SVG = (size: number) => `<svg class="mark-art" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">
  <circle cx="32" cy="38" r="17" class="g-head"/>
  <path d="M17 34 h30" class="g-line" stroke-width="2"/>
  <path d="M18 34 q0 7 6 7 q6 0 6-7 z" class="g-glass"/>
  <path d="M34 34 q0 7 6 7 q6 0 6-7 z" class="g-glass"/>
  <path d="M27 47 q5 4 10 0" fill="none" class="g-line" stroke-width="2" stroke-linecap="round"/>
  <path d="M12 19 q20 -14 40 0 l-3 7 h-34 z" class="g-cap"/>
  <path d="M13 26 h38 q-2 5 -19 5 q-17 0 -19 -5 z" class="g-cap2"/>
  <path d="M32 12 l3.5 2 l-0.7 4.2 l-2.8 2 l-2.8 -2 l-0.7 -4.2 z" class="g-badge"/>
</svg>`;

// Colors for the drawing, per theme.
export const ART_LIGHT = `--g-ink:#151515;--g-head:#ffffff;--g-cap:#1f2f63;--g-cap2:#16234c;--g-badge:#e3b22b;--g-glass:#1c1c1c;--g-glint:#8a8a8a;
--g-gear:#3a3f48;--g-radio:#4c5563;--g-screen:#9fb3a0;--g-light:#f2d46b;--g-baton:#2c3140;--g-buckle:#b9bcc2;--g-shadow:rgba(40,40,70,.28);
--g-scene:#9a978f;--g-bar:#c43b3b;--g-bar2:#f1e3b1;--g-sign:#ffffff;--g-post:#6a7286`;
export const ART_DARK = `--g-ink:#ecebe6;--g-head:#26272b;--g-cap:#3d5bb8;--g-cap2:#2d4592;--g-badge:#ffcf4d;--g-glass:#050505;--g-glint:#9fb8ff;
--g-gear:#8a93a3;--g-radio:#7d8798;--g-screen:#7be3a0;--g-light:#ffe27a;--g-baton:#a9b3c7;--g-buckle:#d9dce3;--g-shadow:rgba(0,0,0,.55);
--g-scene:#5f5d58;--g-bar:#e0605e;--g-bar2:#3a3833;--g-sign:#2b2b2e;--g-post:#7c859a`;

export const ART_CSS = `
.guard-art,.mark-art{display:block}
.g-line{stroke:var(--g-ink)}
.g-head{fill:var(--g-head);stroke:var(--g-ink);stroke-width:3}
.mark-art .g-head{stroke-width:2.5}
.g-cap{fill:var(--g-cap);stroke:var(--g-ink);stroke-width:2.5;stroke-linejoin:round}
.g-cap2{fill:var(--g-cap2);stroke:var(--g-ink);stroke-width:2.5;stroke-linejoin:round}
.g-badge{fill:var(--g-badge);stroke:var(--g-ink);stroke-width:1}
.g-badge-text{stroke:var(--g-head);stroke-width:1.6}
.g-glass{fill:var(--g-glass);stroke:var(--g-ink);stroke-width:1.5}
.g-glint{stroke:var(--g-glint)}
.g-gear{fill:var(--g-gear);stroke:var(--g-ink);stroke-width:1.5}
.g-radio{fill:var(--g-radio);stroke:var(--g-ink);stroke-width:1.5}
.g-screen{fill:var(--g-screen)}
.g-light{fill:var(--g-light);stroke:var(--g-ink);stroke-width:1}
.g-buckle{fill:var(--g-buckle);stroke:var(--g-ink);stroke-width:1}
.g-baton{stroke:var(--g-baton)}
.g-shadow{fill:var(--g-shadow)}
.g-post{fill:var(--g-post);stroke:var(--g-ink);stroke-width:1.5}
.g-bar{fill:var(--g-bar2);stroke:var(--g-ink);stroke-width:1.5}
.g-bar-stripe{fill:var(--g-bar)}
.g-fence{fill:none;stroke:var(--g-scene);stroke-width:2}
.g-mesh{fill:none;stroke:var(--g-scene);stroke-width:1}
.g-sign{fill:var(--g-sign);stroke:var(--g-ink);stroke-width:1.5}
.g-sign-text{stroke:var(--g-ink);stroke-width:2}
.g-scene .g-line{stroke:var(--g-scene)}`;
