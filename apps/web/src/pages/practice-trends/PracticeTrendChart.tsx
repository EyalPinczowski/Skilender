import { diffDays } from '@skillstack/shared';
import { useId } from 'react';
import type { KindTrendData } from '../../api/practice-hooks';
import { formatDate } from '../../lib/format';
import { deltaText, kindLabel, scoreText, sourceLabel } from './practice-labels';

const W = 480;
const H = 250;
const M = { left: 44, right: 30, top: 16, bottom: 56 };
const plotW = W - M.left - M.right;
const plotH = H - M.top - M.bottom;
const yOf = (score: number) => M.top + plotH - (score / 10) * plotH;
const COLOR = 'var(--task-practice)';

/** Self-checks are squares, every other source a circle, so the difference is not colour only. */
function Marker({ self, x, y }: { self: boolean; x: number; y: number }) {
  const common = { fill: 'var(--surface)', stroke: COLOR, strokeWidth: 2.5 };
  return self ? (
    <rect x={x - 4.5} y={y - 4.5} width={9} height={9} {...common} />
  ) : (
    <circle cx={x} cy={y} r={4.5} {...common} />
  );
}

const axisText = { fontSize: 14, fill: 'var(--muted)' } as const;
const axisTitle = { fontSize: 14, fill: 'var(--text)', fontWeight: 700 } as const;

/** One kind: a score-over-time line chart (0 to 10) with a table of the same numbers. */
export function PracticeTrendChart({ trend }: { trend: KindTrendData }) {
  const titleId = useId();
  const label = kindLabel(trend.kind);
  const { points } = trend;
  const first = points[0]?.date ?? '';
  const lastPoint = points[points.length - 1];
  const last = lastPoint?.date ?? first;
  const span = first && last ? diffDays(first, last) : 0;
  const xOf = (date: string) =>
    span === 0 ? M.left + plotW / 2 : M.left + (diffDays(first, date) / span) * plotW;
  const hasSelf = points.some((p) => p.source === 'self_rubric');
  const hasOther = points.some((p) => p.source !== 'self_rubric');
  const count = `${points.length} ${points.length === 1 ? 'practice' : 'practices'}`;
  return (
    <section aria-labelledby={`${titleId}-h`} className="space-y-3">
      <h2 id={`${titleId}-h`}>{label}</h2>
      <p className="tabular-nums">
        Last score {scoreText(trend.last)} of 10 ({deltaText(trend.delta)}). Average{' '}
        {scoreText(trend.average)} over {count}.
      </p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-labelledby={titleId}
        className="h-auto w-full max-w-2xl"
      >
        <title id={titleId}>
          {label} scores from 0 to 10, from {formatDate(first, 'short')} to{' '}
          {formatDate(last, 'short')}. The same data is in the table below.
        </title>
        {[0, 2, 4, 6, 8, 10].map((v) => (
          <g key={v}>
            <line
              x1={M.left}
              x2={W - M.right}
              y1={yOf(v)}
              y2={yOf(v)}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text x={M.left - 8} y={yOf(v) + 5} textAnchor="end" {...axisText}>
              {v}
            </text>
          </g>
        ))}
        <line
          x1={M.left}
          x2={M.left}
          y1={M.top}
          y2={M.top + plotH}
          stroke="var(--muted)"
          strokeWidth={1.5}
        />
        <line
          x1={M.left}
          x2={W - M.right}
          y1={M.top + plotH}
          y2={M.top + plotH}
          stroke="var(--muted)"
          strokeWidth={1.5}
        />
        {span === 0 ? (
          <text x={xOf(first)} y={M.top + plotH + 20} textAnchor="middle" {...axisText}>
            {formatDate(first, 'short')}
          </text>
        ) : (
          <>
            <text x={M.left} y={M.top + plotH + 20} textAnchor="start" {...axisText}>
              {formatDate(first, 'short')}
            </text>
            <text x={W - M.right} y={M.top + plotH + 20} textAnchor="end" {...axisText}>
              {formatDate(last, 'short')}
            </text>
          </>
        )}
        <text x={M.left + plotW / 2} y={H - 8} textAnchor="middle" {...axisTitle}>
          Date
        </text>
        <text
          transform={`translate(12 ${M.top + plotH / 2}) rotate(-90)`}
          textAnchor="middle"
          {...axisTitle}
        >
          Score (0 to 10)
        </text>
        {points.length > 1 ? (
          <polyline
            fill="none"
            stroke={COLOR}
            strokeWidth={2.5}
            strokeLinejoin="round"
            points={points.map((p) => `${xOf(p.date)},${yOf(p.score)}`).join(' ')}
          />
        ) : null}
        {points.map((p, i) => (
          <Marker
            key={`${p.date}-${i}`}
            self={p.source === 'self_rubric'}
            x={xOf(p.date)}
            y={yOf(p.score)}
          />
        ))}
        {lastPoint ? (
          <text
            x={xOf(lastPoint.date)}
            y={yOf(lastPoint.score) - 12}
            textAnchor={span === 0 ? 'middle' : 'end'}
            {...axisTitle}
          >
            {scoreText(lastPoint.score)}
          </text>
        ) : null}
      </svg>
      <p className="flex flex-wrap gap-x-5 text-muted">
        {hasOther ? <span>Circle: feedback from a model or pasted in</span> : null}
        {hasSelf ? <span>Square: self-check</span> : null}
      </p>
      <details className="rounded-sm border border-border">
        <summary className="flex min-h-11 cursor-pointer items-center px-3 font-bold">
          Show {label.toLowerCase()} scores as a table
        </summary>
        <div className="overflow-x-auto px-3 pb-3">
          <table className="w-full min-w-72 border-collapse text-left tabular-nums">
            <caption className="sr-only">{label} scores from 0 to 10, oldest first</caption>
            <thead>
              <tr>
                <th scope="col" className="border-b border-border py-2 pr-3">
                  Date
                </th>
                <th scope="col" className="border-b border-border py-2 pr-3">
                  Score
                </th>
                <th scope="col" className="border-b border-border py-2 pr-3">
                  How it was scored
                </th>
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr key={`${p.date}-${i}`}>
                  <th scope="row" className="border-b border-border py-2 pr-3 font-normal">
                    {formatDate(p.date, 'short')}
                  </th>
                  <td className="border-b border-border py-2 pr-3">{scoreText(p.score)}</td>
                  <td className="border-b border-border py-2 pr-3">{sourceLabel(p.source)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
