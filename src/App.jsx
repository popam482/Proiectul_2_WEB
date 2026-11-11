import { useEffect, useMemo, useState } from 'react';
import './App.css';

const EMISSION_FACTORS = {
  coal: 820,
  gas: 490,
  nuclear: 12,
  hydro: 24,
  wind: 11,
  solar: 48,
  biomass: 230,
};

const SOURCES = [
  ['Coal', 'coal_mw', 'fossil', 'coal'],
  ['Gas', 'gas_mw', 'fossil', 'gas'],
  ['Nuclear', 'nuclear_mw', 'clean', 'nuclear'],
  ['Hydro', 'hydro_mw', 'green', 'hydro'],
  ['Wind', 'wind_mw', 'green', 'wind'],
  ['Solar', 'solar_mw', 'green', 'solar'],
  ['Biomass', 'biomass_mw', 'green', 'biomass'],
];

const FALLBACK_EXCHANGE_RATE = 5.3;
const FALLBACK_ENERGY_PRICE = 100;

function parseNumber(value) {
  let cleaned = String(value || '').replace(/\u202f|\xa0|\s/g, '').replace(/[^0-9,.-]/g, '');
  if (cleaned.includes(',') && cleaned.includes('.')) cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  else if (cleaned.includes(',')) cleaned = cleaned.replace(',', '.');
  return Number.parseFloat(cleaned) || 0;
}

function parseGridHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const row of doc.querySelectorAll('tr')) {
    const cells = [...row.querySelectorAll('th, td')].map((cell) => cell.textContent.trim());
    if (cells.length < 12 || (!cells[0].includes('T') && !/^\d{4}-\d{2}-\d{2}/.test(cells[0]))) continue;

    const values = cells.slice(1, 12).map(parseNumber);
    if (values[0] <= 0 && values[1] <= 0) continue;
    const [consumption, production, nuclear, wind, hydro, gas, coal, solar, biomass] = values;
    const totalGreen = hydro + wind + solar + biomass;
    return {
      timestamp: cells[0].replace('T', ' '),
      consumption_mw: Number(consumption.toFixed(2)),
      production_mw: Number(production.toFixed(2)),
      balance_mw: Number((-values[10]).toFixed(2)),
      total_green_mw: Number(totalGreen.toFixed(2)),
      total_fossil_mw: Number((gas + coal).toFixed(2)),
      green_share_percent: Number(((production ? totalGreen / production : 0) * 100).toFixed(2)),
      coal_mw: coal,
      gas_mw: gas,
      nuclear_mw: nuclear,
      hydro_mw: hydro,
      wind_mw: wind,
      solar_mw: solar,
      biomass_mw: biomass,
    };
  }
  throw new Error('No valid hourly data row found in the grid table.');
}

async function fetchGridHtml() {
  const target = 'https://www.sistemulenergetic.ro/';
  const encoded = encodeURIComponent(target);
  const endpoints = [
    `https://corsproxy.io/?url=${encoded}`,
    `https://api.codetabs.com/v1/proxy?quest=${encoded}`,
    `https://proxy.corsfix.com/?${target}`,
  ];
  const errors = [];
  for (const url of endpoints) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/html, application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      if (html.trim()) return html;
      throw new Error('empty response');
    } catch (error) {
      errors.push(`${new URL(url).hostname}: ${error.name === 'AbortError' ? 'timeout' : error.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`Unable to load grid data. ${errors.join(' | ')}`);
}

async function fetchExchangeRate() {
  try {
    const response = await fetch('https://api.exchangerate-api.com/v4/latest/EUR');
    if (!response.ok) return FALLBACK_EXCHANGE_RATE;
    const data = await response.json();
    return data.rates?.RON || FALLBACK_EXCHANGE_RATE;
  } catch {
    return FALLBACK_EXCHANGE_RATE;
  }
}

async function fetchEnergyPrice() {
  const target = 'https://api.energy-charts.info/price?country=ro';
  const encoded = encodeURIComponent(target);
  const urls = [target, `https://corsproxy.io/?url=${encoded}`, `https://api.codetabs.com/v1/proxy?quest=${encoded}`];
  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const data = await response.json();
      const prices = Array.isArray(data.price) ? data.price.filter((price) => price != null) : [];
      if (prices.length) return prices.at(-1);
    } catch {
      // Try the next endpoint.
    }
  }
  return FALLBACK_ENERGY_PRICE;
}

function formatMw(value) {
  return Number(value).toFixed(2);
}

function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const [data, setData] = useState(null);
  const [carbonIntensity, setCarbonIntensity] = useState(0);
  const [exchangeRate, setExchangeRate] = useState(FALLBACK_EXCHANGE_RATE);
  const [energyPrice, setEnergyPrice] = useState(FALLBACK_ENERGY_PRICE);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [threshold, setThreshold] = useState(100);
  const [category, setCategory] = useState('all');
  const [sortOrder, setSortOrder] = useState('mw-desc');

  useEffect(() => {
    document.body.classList.toggle('dark-mode', theme === 'dark');
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    let active = true;
    Promise.all([fetchGridHtml(), fetchExchangeRate(), fetchEnergyPrice()])
      .then(([html, rate, price]) => {
        if (!active) return;
        const parsed = parseGridHtml(html);
        const emissions = SOURCES.reduce((sum, [, key, , factor]) => sum + parsed[key] * EMISSION_FACTORS[factor], 0);
        setData(parsed);
        setCarbonIntensity(parsed.production_mw > 0 ? Number((emissions / parsed.production_mw).toFixed(2)) : 300);
        setExchangeRate(rate);
        setEnergyPrice(price);
      })
      .catch((loadError) => active && setError(loadError.message || 'An unexpected error occurred while processing grid data.'))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  const sources = useMemo(() => (data ? SOURCES.map(([name, key, type, factor]) => ({
    name, type, mw: data[key], co2TonsPerHour: (data[key] * EMISSION_FACTORS[factor]) / 1000,
  })) : []), [data]);

  const filteredSources = useMemo(() => sources
    .filter((source) => source.mw >= (Number.parseFloat(threshold) || 0) && (category === 'all' || source.type === category || (category === 'clean' && source.type === 'green')))
    .sort((a, b) => sortOrder === 'mw-asc' ? a.mw - b.mw : sortOrder === 'emissions-desc' ? b.co2TonsPerHour - a.co2TonsPerHour : b.mw - a.mw), [sources, threshold, category, sortOrder]);

  const topSource = [...sources].sort((a, b) => b.mw - a.mw)[0];
  const balance = data?.balance_mw || 0;
  const percentage = data?.consumption_mw > 0 ? (Math.abs(balance) / data.consumption_mw) * 100 : 0;
  const ronValue = Math.abs(balance) * energyPrice * exchangeRate;
  const balanceState = balance > 0 ? 'export' : balance < 0 ? 'import' : 'neutral';
  const coverage = Math.max(0, 100 - percentage);
  const advisor = carbonIntensity < 220 && data?.green_share_percent >= 45 && balance >= 0
    ? ['RECOMMENDED', 'Great time to use energy!', `The national grid currently has a low carbon intensity (${carbonIntensity} g CO₂/kWh) and a high share of renewable energy (${data.green_share_percent}%). It is an optimal window for running high-energy appliances or charging devices.`, 'badge-export']
    : carbonIntensity >= 220 && data?.green_share_percent < 30
      ? ['NOT RECOMMENDED', 'Avoid heavy energy consumption!', `Grid emissions are elevated (${carbonIntensity} g CO₂/kWh) and green energy generation is low (${data.green_share_percent}%). Consider postponing heavy energy usage if possible.`, 'badge-import']
      : ['MODERATE', 'Moderate grid impact', `The power grid is operating at average carbon levels (${carbonIntensity} g CO₂/kWh) with a ${data?.green_share_percent || 0}% green share. Consumption impact is neutral.`, 'badge-neutral'];

  return (
    <main className="container">
      <header className="app-header">
        <h1>National Power Grid & Carbon Monitor</h1>
        <p>Real-time energy generation, consumption, and carbon intensity</p>
        <button type="button" className="theme-toggle-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </header>
      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="loading-spinner"><div className="spinner" /><p>Parsing live grid data...</p></div>}
      {!loading && data && <section className="results-container">
        <div className="metrics-grid">
          {[
            ['Carbon Intensity', carbonIntensity, 'g CO₂ / kWh', true],
            ['Total Production', data.production_mw, 'MW'],
            ['Total Consumption', data.consumption_mw, 'MW'],
            ['Green Energy Share', `${data.green_share_percent}%`, '%'],
          ].map(([label, value, unit, highlight]) => <div className="card metric-card" key={label}><span className="metric-label">{label}</span><span className={`metric-value${highlight ? ' highlight' : ''}`}>{value}</span><span className="metric-unit">{unit}</span></div>)}
        </div>

        <div className="card balance-card">
          <div className="balance-header"><span className="info-label">Balance</span><span className={`balance-badge badge-${balanceState}`}>{balanceState === 'neutral' ? 'BALANCE' : balanceState.toUpperCase()}</span></div>
          <div className="balance-main"><div className="balance-icon">{balanceState === 'export' ? 'Export' : balanceState === 'import' ? 'Import' : 'Balance'}</div><div className="balance-info">
            <div className="balance-title">{balanceState === 'export' ? `Export of ${formatMw(Math.abs(balance))} MW (~${ronValue.toLocaleString('ro-RO', { maximumFractionDigits: 0 })} RON/h)` : balanceState === 'import' ? `Import of ${formatMw(Math.abs(balance))} MW (~${ronValue.toLocaleString('ro-RO', { maximumFractionDigits: 0 })} RON/h)` : 'Neutral Balance (0 MW)'}</div>
            <div className="balance-description">{balanceState === 'export' ? `Romania is exporting energy (~${percentage.toFixed(1)}% of consumption).` : balanceState === 'import' ? `The grid imports ${percentage.toFixed(1)}% of consumption.` : 'National production exactly covers domestic consumption.'}</div>
          </div></div>
          <div className="balance-progress-container"><div className="balance-progress-labels"><span>{balanceState === 'import' ? 'National Production vs. Consumption' : 'Internal Production'}</span><span>{balanceState === 'export' ? '100% + Surplus' : balanceState === 'import' ? `${coverage.toFixed(1)}% Domestically Covered` : '100%'}</span></div><div className="progress-bar-bg"><div className={`progress-bar bar-${balanceState}`} style={{ width: `${balanceState === 'export' ? 100 : balanceState === 'import' ? coverage : 100}%` }} /></div></div>
        </div>

        <div className="card advisor-card"><h2>Smart Consumption Advisor</h2><div className="smart-consumption-section"><span className={`balance-badge ${advisor[3]}`}>{advisor[0]}</span><strong>{advisor[1]}</strong></div><p className="advisor-description">{advisor[2]}</p></div>
        <div className="card details-card"><div className="details-header"><h2>Energy Mix Breakdown</h2><span className="timestamp-badge">{data.timestamp}</span></div><div className="breakdown-list">
          {SOURCES.map(([name, key, , factor]) => <div className="breakdown-item-wrapper" key={key}><div className="breakdown-item"><span>{name}</span><strong>{formatMw(data[key])} MW</strong></div><div className="progress-bar-bg"><div className={`progress-bar bar-${factor}`} style={{ width: `${Math.min(100, data.production_mw > 0 ? data[key] / data.production_mw * 100 : 0)}%` }} /></div></div>)}
          <div className="breakdown-item border-top"><span>Grid Balance</span><strong>{formatMw(balance)} MW</strong></div>
        </div></div>

        <div className="card insights-card"><h2>Grid Insights & Advanced Filter</h2><div className="insights-stats"><p>Top Production Source: {topSource?.name} ({formatMw(topSource?.mw)} MW)</p><p>Fossil: <strong className="fossil-text">{data.total_fossil_mw} MW</strong> | Green: <strong className="green-text">{data.total_green_mw} MW</strong></p></div>
          <div className="filter-section"><div className="filter-field"><label htmlFor="mw-threshold">Min Production (MW):</label><input className="filter-control-input" id="mw-threshold" type="number" step="50" value={threshold} onChange={(event) => setThreshold(event.target.value)} /></div><div className="filter-field"><label htmlFor="category-filter">Energy Category:</label><select className="filter-control-select" id="category-filter" value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">All Sources</option><option value="green">Green Only (Hydro, Wind, Solar, Biomass)</option><option value="fossil">Fossil Only (Coal, Gas)</option><option value="clean">Clean Energy (Green + Nuclear)</option></select></div><div className="filter-field"><label htmlFor="sort-order">Sort By:</label><select className="filter-control-select" id="sort-order" value={sortOrder} onChange={(event) => setSortOrder(event.target.value)}><option value="mw-desc">Production (High ➔ Low)</option><option value="mw-asc">Production (Low ➔ High)</option><option value="emissions-desc">Carbon Output (High ➔ Low)</option></select></div></div>
          <ul className="filtered-sources-list">{filteredSources.length ? filteredSources.map((source) => <li key={source.name}><div><strong>{source.name}</strong> <span className={`source-type ${source.type}`}>[{source.type.toUpperCase()}]</span></div><div><strong>{formatMw(source.mw)} MW</strong><span className="source-emissions">(~{source.co2TonsPerHour.toFixed(1)} t CO₂/h)</span></div></li>) : <li className="empty-source">No energy sources match the selected criteria.</li>}</ul>
        </div>
      </section>}
    </main>
  );
}

export default App;
