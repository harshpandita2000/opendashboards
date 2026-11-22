import { ArrowUpRight, Layers3, UserRound, UserRoundPlus } from "lucide-react";
import type { CSSProperties } from "react";
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

export function SharingIllustration() {
  return (
    <div className="launch-art-share-scene" aria-hidden="true">
      <div className="launch-art-preview">
        <div className="launch-art-preview-value">
          <span>Paid conversions</span>
          <strong>1,284</strong>
        </div>
        <span className="launch-art-change">
          <ArrowUpRight /> 12.8%
        </span>
        <div className="launch-art-bars">
          {BARS.map((height, index) => (
            <i
              key={height}
              data-recent={index >= 12 || undefined}
              style={{ height: `${height}%` }}
            />
          ))}
        </div>
      </div>
      <div className="launch-art-share-card">
        <div className="launch-art-share-header">
          <span className="launch-art-dashboard-name">Growth overview</span>
          <span className="launch-art-share-button">
            <UserRoundPlus /> Share
          </span>
        </div>
        <div className="launch-art-share-footer">
          <div className="launch-art-people">
            <span>
              <UserRound />
            </span>
            <span>
              <UserRound />
            </span>
            <span>
              <UserRound />
            </span>
          </div>
          <div className="launch-art-share-marks">
            <SourceMark source="posthog" />
            <SourceMark source="postgres" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function SourcesIllustration() {
  return (
    <div className="launch-art-sources-scene" aria-hidden="true">
      <div className="launch-art-metric">
        <span className="launch-art-metric-label">Paid conversions</span>
        <strong>1,284</strong>
      </div>
      <div className="launch-art-source-card">
        <div className="launch-art-source-heading">
          <Layers3 /> Sources
        </div>
        <div className="launch-art-source-row">
          <div className="launch-art-source">
            <SourceMark source="posthog" />
            <div>
              <strong>Signups</strong>
              <span>PostHog</span>
            </div>
          </div>
          <div className="launch-art-source">
            <SourceMark source="postgres" />
            <div>
              <strong>Orders</strong>
              <span>PostgreSQL</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
