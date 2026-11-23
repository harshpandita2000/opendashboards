"use client";

import {
  ArrowUpRight,
  Check,
  CircleDot,
  Layers3,
  Link2,
  LockKeyhole,
  Pause,
  Play,
  RotateCcw,
  UserRound,
  UserRoundPlus,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { BRANDS } from "../brands";
import "./launch-illustrations.css";

const SOURCE_MARKS = {
  posthog: BRANDS.posthog.mask,
  postgres: BRANDS.postgres.mask,
};

function SourceMark({ source }: { source: keyof typeof SOURCE_MARKS }) {
  return (
    <span
      className="launch-art-source-mark"
      data-source={source}
      style={{ "--source-mark": SOURCE_MARKS[source] } as CSSProperties}
    />
  );
}

const BARS = [24, 35, 29, 49, 45, 39, 63, 57, 73, 68, 82, 77, 91, 87, 100, 96];

const SHARE_TIMINGS = [1150, 220, 1000, 1150, 1300] as const;
const BUILD_TIMINGS = [950, 1050, 1150, 1250, 220] as const;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeToMotion(onChange: () => void) {
  const media = window.matchMedia(REDUCED_MOTION);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function Scene({
  label,
  timings,
  children,
}: {
  label: string;
  timings: readonly number[];
  children: (phase: number) => ReactNode;
}) {
  const view = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduced = useSyncExternalStore(
    subscribeToMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
  const complete = phase === timings.length;

  useEffect(() => {
    const target = view.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: 0.4 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || paused || reduced || complete) return;
    const timer = window.setTimeout(() => setPhase((current) => current + 1), timings[phase]);
    return () => window.clearTimeout(timer);
  }, [phase, paused, reduced, visible, complete, timings]);

  const action = complete ? "Replay" : paused ? "Resume" : "Pause";

  return (
    <div ref={view} className="launch-art-scene" data-resting={!visible || paused || reduced || undefined}>
      <div className="launch-art-scene-art" aria-hidden="true">{children(reduced ? timings.length : phase)}</div>
      {!reduced && (
        <button
          className="launch-art-playback"
          type="button"
          aria-label={`${action} ${label} animation`}
          onClick={() => {
            if (complete) setPhase(0);
            setPaused(!complete && !paused);
          }}
        >
          {complete ? <RotateCcw /> : paused ? <Play /> : <Pause />}
        </button>
      )}
    </div>
  );
}

function Bars() {
  return (
    <div className="launch-art-bars">
      {BARS.map((height, index) => (
        <i key={height} data-recent={index >= 12 || undefined} style={{ height: `${height}%` }} />
      ))}
    </div>
  );
}

export function SharingIllustration() {
  return (
    <Scene label="sharing" timings={SHARE_TIMINGS}>
      {(phase) => (
        <div className="launch-art-share-scene" data-modal={phase >= 2 || undefined}>
          <div className="launch-art-preview">
            <div className="launch-art-preview-value">
              <span>Paid conversions</span>
              <strong>1,284</strong>
            </div>
            <span className="launch-art-change"><ArrowUpRight /> 12.8%</span>
            <Bars />
          </div>
          <div className="launch-art-share-card">
            <div className="launch-art-share-header">
              <span className="launch-art-dashboard-name">Growth overview</span>
              <span className="launch-art-share-button" data-pressed={phase === 1 || undefined}>
                <UserRoundPlus /> Share
              </span>
            </div>
            <div className="launch-art-share-footer">
              <div className="launch-art-people">
                <span><UserRound /></span>
                <span><UserRound /></span>
                <span><UserRound /></span>
              </div>
              <div className="launch-art-share-marks">
                <SourceMark source="posthog" />
                <SourceMark source="postgres" />
              </div>
            </div>
          </div>
          <div className="launch-art-scrim" data-open={phase >= 2 || undefined} />
          <div className="launch-art-dialog" data-open={phase >= 2 || undefined}>
            <strong className="launch-art-dialog-title">Share dashboard</strong>
            <span className="launch-art-dialog-context">Growth overview</span>
            <div className="launch-art-password-row">
              <LockKeyhole />
              <span>Require a password</span>
              <i className="launch-art-password-switch" data-checked={phase >= 3 || undefined} />
            </div>
            <div className="launch-art-password-value" data-revealed={phase >= 3 || undefined}>
              <span>Password</span><span>••••••••</span>
            </div>
            <div className="launch-art-copy-link">
              {phase === 5 ? <><Check /> Link copied</> : <><Link2 /> Copy link</>}
            </div>
          </div>
        </div>
      )}
    </Scene>
  );
}

const BUILD_STEPS = [
  "Check available data",
  "Query signups and orders",
  "Build the dashboard",
] as const;

export function SourcesIllustration() {
  return (
    <Scene label="dashboard build and sources" timings={BUILD_TIMINGS}>
      {(phase) => (
        <div className="launch-art-sources-scene">
          <div className="launch-art-dashboard">
            <div className="launch-art-dashboard-top">
              <span>Growth overview</span>
              <span className="launch-art-sources-trigger" data-ready={phase >= 3 || undefined} data-pressed={phase === 4 || undefined}>
                <Layers3 /> Sources
              </span>
            </div>
            <div className="launch-art-dashboard-body">
              <div className="launch-art-skeleton" data-loaded={phase >= 3 || undefined}>
                <div className="launch-art-skeleton-metrics"><i /><i /><i /></div>
                <div className="launch-art-skeleton-plot">
                  <i />
                  <Bars />
                </div>
              </div>
              <div className="launch-art-dashboard-data" data-loaded={phase >= 3 || undefined}>
                <div className="launch-art-dashboard-metrics">
                  <div><span>Paid conversions</span><strong>1,284</strong></div>
                  <div><span>Signups</span><strong>26,750</strong></div>
                  <div><span>Conversion rate</span><strong>4.8%</strong></div>
                </div>
                <div className="launch-art-dashboard-plot">
                  <span>Paid conversions over time</span>
                  <Bars />
                </div>
              </div>
            </div>
          </div>
          <div className="launch-art-build-status" data-open={phase < 3 || undefined}>
            <strong className="launch-art-dialog-title">Building dashboard</strong>
            <ol className="launch-art-build-steps">
              {BUILD_STEPS.map((step, index) => (
                <li key={step} data-visible={index <= phase || undefined} data-current={index === phase || undefined}>
                  <span>{index < phase ? <Check /> : <CircleDot />}{step}</span>
                </li>
              ))}
            </ol>
          </div>
          <div className="launch-art-scrim" data-open={phase === 5 || undefined} />
          <div className="launch-art-dialog" data-open={phase === 5 || undefined}>
            <strong className="launch-art-dialog-title"><Layers3 /> Sources</strong>
            <span className="launch-art-dialog-context">Paid conversions</span>
            <div className="launch-art-source-row">
              <div className="launch-art-source">
                <SourceMark source="posthog" />
                <div><strong>Signups</strong><span>PostHog</span></div>
              </div>
              <div className="launch-art-source">
                <SourceMark source="postgres" />
                <div><strong>Orders</strong><span>PostgreSQL</span></div>
              </div>
            </div>
            <div className="launch-art-analysis">
              <strong>Data analysis</strong>
              <span>Matched signups with paid orders.</span>
            </div>
          </div>
        </div>
      )}
    </Scene>
  );
}
