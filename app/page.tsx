'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, {
  type FilterSpecification,
  type GeoJSONSource,
  type Map as MapLibreMap,
  type MapMouseEvent,
} from 'maplibre-gl';

const DATA_URL =
  'https://data.sfgov.org/resource/3i4a-hu95.geojson?$limit=20000';

const INITIAL_VIEW = {
  center: [-122.438, 37.758] as [number, number],
  zoom: 11.55,
  bearing: 0,
  pitch: 0,
};

const CATEGORIES = [
  { label: 'All zones', value: 'all', color: '#f05a3c' },
  { label: 'Residential', value: 'Residential', color: '#f1c75b' },
  { label: 'Mixed use', value: 'Mixed Use', color: '#ef9562' },
  { label: 'Commercial', value: 'Commercial', color: '#c27ad3' },
  { label: 'Industrial', value: 'Industrial', color: '#6d96a8' },
  { label: 'Public', value: 'Public', color: '#7ebf8d' },
] as const;

type CategoryValue = (typeof CATEGORIES)[number]['value'];

type ZoneDetails = {
  zoning: string;
  name: string;
  category: string;
  codeSection?: string;
  codeUrl?: string;
};

function getZoneDetails(properties: Record<string, unknown>): ZoneDetails {
  return {
    zoning: String(properties.zoning_sim ?? properties.zoning ?? 'Unknown'),
    name: String(properties.districtna ?? 'Unspecified zoning district'),
    category: String(properties.gen ?? 'Other'),
    codeSection: properties.codesectio
      ? String(properties.codesectio)
      : undefined,
    codeUrl: properties.url ? String(properties.url) : undefined,
  };
}

function buildFilter(category: CategoryValue, search: string): FilterSpecification {
  const clauses: unknown[] = ['all'];

  if (category !== 'all') {
    clauses.push(['==', ['get', 'gen'], category]);
  }

  const query = search.trim().toLocaleLowerCase();
  if (query) {
    clauses.push([
      'any',
      ['in', query, ['downcase', ['to-string', ['get', 'zoning_sim']]]],
      ['in', query, ['downcase', ['to-string', ['get', 'districtna']]]],
    ]);
  }

  return clauses as FilterSpecification;
}

export default function Home() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const hoveredFeatureRef = useRef<string | number | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [category, setCategory] = useState<CategoryValue>('all');
  const [search, setSearch] = useState('');
  const [selectedZone, setSelectedZone] = useState<ZoneDetails | null>(null);
  const [hoveredZone, setHoveredZone] = useState<ZoneDetails | null>(null);
  const [zoneCount, setZoneCount] = useState<number | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  const activeCategory = useMemo(
    () => CATEGORIES.find((item) => item.value === category) ?? CATEGORIES[0],
    [category],
  );

  const clearHover = useCallback(() => {
    const map = mapRef.current;
    if (map && hoveredFeatureRef.current !== null) {
      map.setFeatureState(
        { source: 'sf-zoning', id: hoveredFeatureRef.current },
        { hover: false },
      );
    }
    hoveredFeatureRef.current = null;
    setHoveredZone(null);
  }, []);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      ...INITIAL_VIEW,
      minZoom: 10.5,
      maxZoom: 18,
      maxBounds: [
        [-122.58, 37.68],
        [-122.32, 37.86],
      ],
      attributionControl: false,
    });

    mapRef.current = map;
    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true }),
      'top-right',
    );
    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      'bottom-right',
    );

    map.on('load', () => {
      map.addSource('sf-zoning', {
        type: 'geojson',
        data: DATA_URL,
        generateId: true,
      });

      map.addLayer({
        id: 'zoning-fill',
        type: 'fill',
        source: 'sf-zoning',
        paint: {
          'fill-color': [
            'match',
            ['get', 'gen'],
            'Residential',
            '#f1c75b',
            'Mixed Use',
            '#ef9562',
            'Mixed',
            '#ef9562',
            'Commercial',
            '#c27ad3',
            'Industrial',
            '#6d96a8',
            'Public',
            '#7ebf8d',
            '#a5a29b',
          ],
          'fill-opacity': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            0.86,
            0.66,
          ],
        },
      });

      map.addLayer({
        id: 'zoning-outline',
        type: 'line',
        source: 'sf-zoning',
        paint: {
          'line-color': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            '#171917',
            'rgba(42, 45, 42, 0.34)',
          ],
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            2.2,
            ['interpolate', ['linear'], ['zoom'], 10, 0.35, 16, 1.15],
          ],
        },
      });

      map.addLayer({
        id: 'zoning-labels',
        type: 'symbol',
        source: 'sf-zoning',
        minzoom: 13.3,
        layout: {
          'text-field': ['get', 'zoning_sim'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 13, 9, 16, 11],
          'text-font': ['Open Sans Semibold'],
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#242624',
          'text-halo-color': 'rgba(255, 252, 245, 0.88)',
          'text-halo-width': 1.25,
        },
      });

      setMapReady(true);
    });

    map.on('sourcedata', (event) => {
      if (event.sourceId !== 'sf-zoning' || !event.isSourceLoaded) return;
      const source = map.getSource('sf-zoning') as GeoJSONSource | undefined;
      if (!source) return;
      setZoneCount(map.querySourceFeatures('sf-zoning').length);
    });

    const handleMouseMove = (event: MapMouseEvent) => {
      const feature = map.queryRenderedFeatures(event.point, {
        layers: ['zoning-fill'],
      })[0];

      if (!feature) {
        map.getCanvas().style.cursor = '';
        clearHover();
        return;
      }

      map.getCanvas().style.cursor = 'pointer';
      if (feature.id !== hoveredFeatureRef.current) {
        clearHover();
        if (feature.id !== undefined) {
          hoveredFeatureRef.current = feature.id;
          map.setFeatureState(
            { source: 'sf-zoning', id: feature.id },
            { hover: true },
          );
        }
      }
      setHoveredZone(getZoneDetails(feature.properties ?? {}));
    };

    map.on('mousemove', handleMouseMove);
    map.on('mouseout', clearHover);
    map.on('click', (event) => {
      const feature = map.queryRenderedFeatures(event.point, {
        layers: ['zoning-fill'],
      })[0];
      if (!feature) return;
      setSelectedZone(getZoneDetails(feature.properties ?? {}));
      setPanelOpen(true);
    });
    map.on('error', (event) => {
      const message = String(event.error?.message ?? '');
      if (message.includes('3i4a-hu95') || message.includes('sf-zoning')) {
        setLoadError(true);
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [clearHover]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const filter = buildFilter(category, search);
    ['zoning-fill', 'zoning-outline', 'zoning-labels'].forEach((layer) => {
      map.setFilter(layer, filter);
    });
    clearHover();
  }, [category, search, mapReady, clearHover]);

  const resetView = () => {
    mapRef.current?.easeTo({ ...INITIAL_VIEW, duration: 900 });
  };

  const detailZone = selectedZone ?? hoveredZone;

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#map" aria-label="SF Zoning Atlas home">
          <span className="brand-mark">SF</span>
          <span>Zoning Atlas</span>
        </a>
        <div className="dataset-status" aria-label="Data source status">
          <span className={loadError ? 'status-dot error' : 'status-dot'} />
          {loadError ? 'Data unavailable' : 'Official DataSF layer'}
        </div>
        <a
          className="planning-link"
          href="https://sfplanning.org/zoning"
          target="_blank"
          rel="noreferrer"
        >
          SF Planning <span aria-hidden="true">↗</span>
        </a>
      </header>

      <section className="workspace">
        <aside className={`side-panel ${panelOpen ? 'panel-open' : ''}`}>
          <div className="intro-block">
            <p className="eyebrow">San Francisco zoning explorer</p>
            <h1>Read the city,<br />parcel by parcel.</h1>
            <p className="lede">
              Explore current use districts across San Francisco. Filter the
              map or select a zone to open its Planning Code reference.
            </p>
          </div>

          <div className="search-block">
            <label htmlFor="zone-search">Find a zone</label>
            <div className="search-input-wrap">
              <span aria-hidden="true" className="search-icon" />
              <input
                id="zone-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Try RH-2 or neighborhood commercial"
                autoComplete="off"
              />
              {search && (
                <button
                  type="button"
                  className="clear-search"
                  onClick={() => setSearch('')}
                  aria-label="Clear zone search"
                >
                  ×
                </button>
              )}
            </div>
          </div>

          <div className="filter-block">
            <div className="section-heading">
              <span>District type</span>
              <span className="count-label">
                {zoneCount ? `${zoneCount.toLocaleString()} shapes` : 'Loading…'}
              </span>
            </div>
            <div className="category-list" role="list" aria-label="Zoning categories">
              {CATEGORIES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={`category-button ${category === item.value ? 'active' : ''}`}
                  onClick={() => setCategory(item.value)}
                  aria-pressed={category === item.value}
                >
                  <span className="category-swatch" style={{ backgroundColor: item.color }} />
                  <span>{item.label}</span>
                  {category === item.value && <span className="category-check">✓</span>}
                </button>
              ))}
            </div>
          </div>

          <div className="panel-note">
            <span className="note-index">01</span>
            <p>
              Boundaries are for exploration. Confirm a property’s zoning with
              the official SF Planning map before making decisions.
            </p>
          </div>
        </aside>

        <section className="map-stage" id="map" aria-label="Interactive San Francisco zoning map">
          <div ref={mapContainerRef} className="map-canvas" />

          {!mapReady && !loadError && (
            <div className="map-loading" role="status">
              <span className="loading-spinner" />
              Drawing zoning districts…
            </div>
          )}

          {loadError && (
            <div className="map-error" role="alert">
              <strong>The zoning layer couldn’t load.</strong>
              <span>Check your connection and refresh to try again.</span>
            </div>
          )}

          <div className="map-toolbar">
            <button type="button" onClick={resetView} aria-label="Reset map to San Francisco">
              <span className="target-icon" aria-hidden="true" />
              Reset view
            </button>
            <span className="toolbar-divider" />
            <span className="active-layer">
              <i style={{ backgroundColor: activeCategory.color }} />
              {activeCategory.label}
            </span>
          </div>

          {detailZone && (
            <article className="zone-card" aria-live="polite">
              <button
                type="button"
                className="zone-card-close"
                onClick={() => {
                  setSelectedZone(null);
                  setPanelOpen(false);
                }}
                aria-label="Close zone details"
              >
                ×
              </button>
              <div className="zone-card-topline">
                <span className="zone-code">{detailZone.zoning}</span>
                <span className="zone-category">{detailZone.category}</span>
              </div>
              <h2>{detailZone.name.toLocaleLowerCase()}</h2>
              <div className="zone-card-meta">
                <span>Use district</span>
                <strong>
                  {detailZone.codeSection ? `Code § ${detailZone.codeSection}` : 'See Planning Code'}
                </strong>
              </div>
              {detailZone.codeUrl && (
                <a href={detailZone.codeUrl} target="_blank" rel="noreferrer">
                  Open code reference <span aria-hidden="true">↗</span>
                </a>
              )}
            </article>
          )}

          {!detailZone && mapReady && (
            <div className="map-hint">
              <span className="cursor-dot" aria-hidden="true" />
              Hover or tap a district to inspect it
            </div>
          )}

          <button
            type="button"
            className="mobile-panel-toggle"
            onClick={() => setPanelOpen((open) => !open)}
            aria-expanded={panelOpen}
          >
            {panelOpen ? 'Hide filters' : 'Explore zones'}
          </button>
        </section>
      </section>
    </main>
  );
}
