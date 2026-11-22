import { ArrowUpRight, ScanLine, UserRound, UserRoundPlus } from "lucide-react";
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

const BARS = [43, 34, 57, 48, 66, 56, 61, 79, 71, 89, 82, 100];

export function SharingIllustration() {
  return (
    <div className="launch-art-share-scene" aria-hidden="true">
      <div className="launch-art-preview">
        <div className="launch-art-preview-chart">
          <span className="launch-art-preview-label">Paid conversions</span>
          <div className="launch-art-bars">
            {BARS.map((height, index) => (
              <i key={height} data-recent={index > 8 || undefined} style={{ height: `${height}%` }} />
            ))}
          </div>
        </div>
        <div className="launch-art-preview-tile">
          <span className="launch-art-preview-label">Conversion rate</span>
          <strong>4.8%</strong>
          <ArrowUpRight />
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
    </div>
  );
}

export function SourcesIllustration() {
  return (
    <div className="launch-art-sources-scene" aria-hidden="true">
      <div className="launch-art-metric">
        <div>
          <span className="launch-art-metric-label">Paid conversions</span>
          <strong>1,284</strong>
        </div>
        <span className="launch-art-inspect"><ScanLine /></span>
      </div>
      <div className="launch-art-source-branch">
        <span>Sources</span>
      </div>
      <div className="launch-art-source-row">
        <div className="launch-art-source">
          <SourceMark source="posthog" />
          <div><strong>PostHog</strong><span>Signups</span></div>
        </div>
        <div className="launch-art-source">
          <SourceMark source="postgres" />
          <div><strong>PostgreSQL</strong><span>Orders</span></div>
        </div>
      </div>
    </div>
  );
}
