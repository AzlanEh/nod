import { useState } from 'react';
import { mapLocationUrl, type Presentation } from '../../shared/presentation';
import { AlertCircle, ChevronDown, ExternalLink } from './icons';

type Visual<T extends Presentation['type']> = Extract<Presentation, { type: T }>;
type Item = Visual<'items'>['items'][number];
type Located = Item & { location: NonNullable<Item['location']> };

export function CardHead({
  visual,
}: {
  visual: Visual<'items' | 'schedule' | 'facts' | 'compare'>;
}) {
  return (
    <header className="card-head">
      <strong>{visual.title}</strong>
      {visual.type === 'facts' && visual.status && (
        <em className="card-status" data-tone={visual.status.tone}>
          {visual.status.label}
        </em>
      )}
    </header>
  );
}

export function CardNote({ note }: { note?: string }) {
  return note ? <p className="card-band card-note">{note}</p> : null;
}

export function Items({ visual }: { visual: Visual<'items'> }) {
  const located = visual.items.every((item) => item.location) ? (visual.items as Located[]) : null;
  const [open, setOpen] = useState<number | null>(null);
  const [selected, setSelected] = useState(0);
  const dots = visual.items.some((item) => item.status);
  return (
    <div className="card-band">
      {visual.label && (
        <p className="card-label">
          {visual.label} <span>{visual.items.length}</span>
        </p>
      )}
      {located && located.length > 1 && (
        <Pins items={located} selected={selected} onSelect={setSelected} />
      )}
      <ul
        className="card-items"
        data-gutter={dots ? 'dot' : located && located.length > 1 ? 'index' : undefined}
      >
        {visual.items.map((item, index) => {
          const expandable = Boolean(item.detail || item.facts);
          const link = item.url ?? (item.location && mapLocationUrl(item.location));
          const row = (
            <>
              {dots && <span className="card-dot" data-tone={item.status?.tone ?? 'none'} />}
              {located && located.length > 1 && <span className="card-index">{index + 1}</span>}
              <span className="card-main">
                <span className="card-title">{item.title}</span>
                {(item.status || item.sub) && (
                  <span className="card-sub">
                    {item.status && <span className="card-row-status">{item.status.label}</span>}
                    {item.status && item.sub && ' · '}
                    {item.sub}
                  </span>
                )}
                {item.route && <Route route={item.route} />}
                {item.warning && (
                  <span className="card-warning">
                    <AlertCircle size={13} aria-hidden="true" />
                    {item.warning}
                  </span>
                )}
              </span>
              {item.value && (
                <span className="card-value">
                  {item.value}
                  {item.valueSub && <small>{item.valueSub}</small>}
                </span>
              )}
              {expandable ? (
                <ChevronDown size={14} className="card-chevron" aria-hidden="true" />
              ) : (
                link && <ExternalLink size={13} className="card-chevron" aria-hidden="true" />
              )}
            </>
          );
          return (
            <li
              key={index}
              data-open={open === index || undefined}
              data-tall={item.route ? true : undefined}
              data-selected={(located && selected === index) || undefined}
              onPointerEnter={located ? () => setSelected(index) : undefined}
            >
              {expandable ? (
                <button
                  type="button"
                  className="card-row"
                  aria-expanded={open === index}
                  onClick={() => setOpen(open === index ? null : index)}
                >
                  {row}
                </button>
              ) : link ? (
                <a
                  className="card-row"
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                >
                  {row}
                </a>
              ) : (
                <div className="card-row">{row}</div>
              )}
              {open === index && (
                <div className="card-detail">
                  {item.detail && <p>{item.detail}</p>}
                  {item.facts && <Facts items={item.facts} />}
                  {link && (
                    <a
                      className="button button-outline button-sm card-open"
                      href={link}
                      target="_blank"
                      rel="noopener noreferrer"
                      referrerPolicy="no-referrer"
                    >
                      Open on {new URL(link).hostname.replace(/^www\./, '')}
                      <ExternalLink size={13} aria-hidden="true" />
                    </a>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Route({ route }: { route: NonNullable<Item['route']> }) {
  return (
    <span className="card-route">
      <span className="flight-route">
        <span className="flight-airport">
          {route.from.time && <strong>{route.from.time}</strong>}
          <span className="flight-airport-code">{route.from.place}</span>
          {route.from.note && <span className="flight-airport-date">{route.from.note}</span>}
        </span>
        <span className="flight-journey">
          <span className="flight-track">
            <i />
          </span>
          {route.middle?.map((line, index) => (
            <span key={index}>{line}</span>
          ))}
        </span>
        <span className="flight-airport">
          {route.to.time && <strong>{route.to.time}</strong>}
          <span className="flight-airport-code">{route.to.place}</span>
          {route.to.note && <span className="flight-airport-date">{route.to.note}</span>}
        </span>
      </span>
      {route.stops?.map((stop, index) => (
        <span className="card-stop" key={index}>
          {stop.label} · <b>{stop.place}</b>
          {stop.detail && ` · ${stop.detail}`}
        </span>
      ))}
    </span>
  );
}

function Pins({
  items,
  selected,
  onSelect,
}: {
  items: Located[];
  selected: number;
  onSelect: (index: number) => void;
}) {
  const lat = items.map((item) => item.location.latitude);
  const lon = items.map((item) => item.location.longitude);
  const midLat = (Math.min(...lat) + Math.max(...lat)) / 2;
  const midLon = (Math.min(...lon) + Math.max(...lon)) / 2;
  const squash = Math.cos((midLat * Math.PI) / 180);
  const span = Math.max(
    (Math.max(...lon) - Math.min(...lon)) * squash,
    Math.max(...lat) - Math.min(...lat),
    0.001,
  );
  return (
    <div className="card-plot">
      <div className="places-plot">
        {items.map((item, index) => (
          <div
            key={index}
            className="place-marker-group"
            style={{
              left: `${50 + (((item.location.longitude - midLon) * squash) / span) * 70}%`,
              top: `${50 - ((item.location.latitude - midLat) / span) * 70}%`,
            }}
          >
            <button
              type="button"
              className="place-pin"
              aria-label={`Show ${item.title}`}
              aria-pressed={selected === index}
              onClick={() => onSelect(index)}
            >
              {index + 1}
            </button>
          </div>
        ))}
      </div>
      <span className="places-map-label">Relative locations</span>
    </div>
  );
}

export function Schedule({ visual }: { visual: Visual<'schedule'> }) {
  return (
    <div className="card-band">
      <ol className="card-schedule">
        {visual.items.map((item, index) => (
          <li key={index} data-quiet={item.quiet || undefined}>
            <span className="card-time">
              {item.start}
              {item.end && <small>{item.end}</small>}
            </span>
            <span className="card-bar" data-clash={item.clash || undefined} />
            <span className="card-main">
              <span className="card-title">{item.title}</span>
              {item.detail && <small>{item.detail}</small>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Facts({ items }: { items: Array<{ label: string; value: string; strong?: boolean }> }) {
  return (
    <dl className="card-facts">
      {items.map((item, index) => (
        <div key={index} data-strong={item.strong || undefined}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function FactList({ visual }: { visual: Visual<'facts'> }) {
  return (
    <div className="card-band">
      <Facts items={visual.items} />
    </div>
  );
}

export function Compare({ visual }: { visual: Visual<'compare'> }) {
  return (
    <div className="card-band">
      <div className="card-compare-scroll">
        <table className="card-compare">
          <thead>
            <tr>
              <td />
              {visual.columns.map((column, index) => (
                <th key={index} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visual.rows.map((row, rowIndex) => {
              const largest = Math.max(0, ...(row.amounts ?? []));
              return (
                <tr key={rowIndex}>
                  <th scope="row">{row.label}</th>
                  {row.values.map((value, index) => (
                    <td key={index} data-best={row.best === index || undefined}>
                      {value}
                      {row.amounts && largest > 0 && (
                        <span className="card-barline" aria-hidden="true">
                          <i style={{ width: `${(row.amounts[index]! / largest) * 100}%` }} />
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {visual.verdict && <p className="card-verdict">{visual.verdict}</p>}
    </div>
  );
}
