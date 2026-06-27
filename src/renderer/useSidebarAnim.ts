import { useCallback, useRef, useState } from 'react';
import { api } from './store';

// Animation manager for the sidebar's collapse/expand transitions.
//
// Two scripted footer animations hang off the toggle:
//   - 'collapsing': expand -> collapse. The three action buttons shuffle into a
//     deck against the wall (lock, then settings, then bell on top), pause, then
//     the expand button is pulled from behind the pile, up over the top, and
//     dropped in front.
//   - 'falling': collapse -> expand while the vertical list is open. The stacked
//     buttons align on the diagonal and fall into the horizontal row.
//
// Separately, the native Discord views (a layer the OS composites *over* the
// DOM, so CSS can't touch them) are kept glued to the sidebar's moving edge by
// the lockstep driver below — see `startDrive`.
//
// The scripted expand ('expanding') runs the head sequence (inbox coughs over the
// toggle, spits it out, then "wumpiary" walks in) plus the footer arrival; the
// `footFall` flag selects the footer arrival (matrix-fall when the action list was
// open vs the plain spread otherwise), but the ending bell-punch is shared.
//
// Durations MUST stay in sync with the matching keyframes in styles.css.
export type FootAnim = 'idle' | 'collapsing' | 'expanding';

const DURATION: Record<Exclude<FootAnim, 'idle'>, number> = {
  // Collapse rail + choreography. Sped up so closing no longer feels sluggish.
  // Kept in sync with the keyframes and the .sidebar.anim-collapsing width
  // transition in styles.css.
  collapsing: 1000,
  // Expand: head cough/spit/brand-walk + footer arrival + the shared bell-punch.
  expanding: 1700,
};
// Safety net: if the width `transitionend` never lands (animation interrupted,
// transition cancelled, etc.) stop driving anyway so the override can't stick.
const DRIVE_TIMEOUT = 2500;

export function useSidebarAnim() {
  const [anim, setAnim] = useState<FootAnim>('idle');
  // During an expand, whether the footer plays the matrix-fall (the action list
  // was open) or the plain spread. The ending bell-punch is the same either way.
  const [footFall, setFootFall] = useState(false);
  const [busy, setBusy] = useState(false);
  const animTimer = useRef<number | undefined>(undefined);
  const busyTimer = useRef<number | undefined>(undefined);
  // Attached to the .sidebar element so the driver can read its live, CSS-
  // interpolated width each frame.
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | undefined>(undefined);
  const driveTimer = useRef<number | undefined>(undefined);
  const driving = useRef(false);
  const endHandler = useRef<((e: TransitionEvent) => void) | undefined>(undefined);

  const busyFor = (ms: number) => {
    setBusy(true);
    window.clearTimeout(busyTimer.current);
    busyTimer.current = window.setTimeout(() => setBusy(false), ms);
  };

  // ---- lockstep driver ----------------------------------------------------
  // Feed the rail's real rendered width to main every frame so the native
  // account views track the moving edge instead of snapping to the final
  // bounds. We read the actual width rather than replaying the easing curve, so
  // this stays correct no matter how the CSS duration/timing changes.
  const stopDrive = useCallback(() => {
    if (!driving.current) return;
    driving.current = false;
    if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
    window.clearTimeout(driveTimer.current);
    if (endHandler.current) sidebarRef.current?.removeEventListener('transitionend', endHandler.current);
    api.layoutSidebar(null); // release the override; settle to the configured width
  }, []);

  const frame = useCallback(() => {
    if (!driving.current) return;
    const el = sidebarRef.current;
    if (el) api.layoutSidebar(el.getBoundingClientRect().width);
    rafRef.current = requestAnimationFrame(frame);
  }, []);

  const startDrive = useCallback(() => {
    const el = sidebarRef.current;
    if (!el) return; // nothing mounted yet -> main's config-driven layout still applies
    if (driving.current) stopDrive();
    // Seed the override with the CURRENT width before the collapsed flag flips,
    // so the layout() that patchUi triggers doesn't snap to the final bounds for
    // a frame before our first rAF lands.
    api.layoutSidebar(el.getBoundingClientRect().width);
    driving.current = true;
    // The rail's own `width` settle marks the end of the resize. Children's
    // transitions bubble here too, so match target + property exactly.
    const handler = (e: TransitionEvent) => {
      if (e.target === sidebarRef.current && e.propertyName === 'width') stopDrive();
    };
    endHandler.current = handler;
    el.addEventListener('transitionend', handler);
    rafRef.current = requestAnimationFrame(frame);
    window.clearTimeout(driveTimer.current);
    driveTimer.current = window.setTimeout(stopDrive, DRIVE_TIMEOUT);
  }, [frame, stopDrive]);

  // `closeFoot` collapses the vertical list. For a deck collapse it fires up
  // front; for the matrix-fall it fires once the buttons have landed.
  const toggle = useCallback((collapsed: boolean, footOpen: boolean, closeFoot: () => void) => {
    window.clearTimeout(animTimer.current);
    // Start gluing the views to the rail before flipping the flag (see startDrive).
    startDrive();

    if (!collapsed) {
      // Collapsing: flip the real flag NOW so the rail starts shrinking, but the
      // 'collapsing' class stretches the width transition to span the deck (see
      // .sidebar.anim-collapsing in styles.css). The rail then shrinks *under*
      // the choreography — the centred pile/button just follows the moving
      // centre — instead of finishing early and cramming the deck into 64px.
      closeFoot();
      setAnim('collapsing');
      animTimer.current = window.setTimeout(() => setAnim('idle'), DURATION.collapsing);
      busyFor(DURATION.collapsing);
      api.patchUi({ sidebarCollapsed: true });
      return;
    }

    // Expanding: grow now so the head/footer choreography has room. The footer
    // arrival differs by whether the action list was open (matrix-fall vs plain
    // spread); the head sequence and the ending bell-punch are the same.
    setAnim('expanding');
    setFootFall(footOpen);
    animTimer.current = window.setTimeout(() => {
      setAnim('idle');
      setFootFall(false);
      closeFoot(); // the action list (if any) is folded away once the row has landed
    }, DURATION.expanding);
    busyFor(DURATION.expanding);
    api.patchUi({ sidebarCollapsed: false });
  }, [startDrive]);

  return { anim, busy, footFall, toggle, sidebarRef };
}
