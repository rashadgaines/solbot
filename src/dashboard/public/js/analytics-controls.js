document.addEventListener('DOMContentLoaded', () => {
    const controls = document.getElementById('analytics-controls');
    if (controls) {
        setupControls(controls);
    }
});

function setupControls(controls) {
    controls.innerHTML = `
        <div class="filter-controls">
            <select id="timeRange">
                <option value="1h">Last Hour</option>
                <option value="6h">Last 6 Hours</option>
                <option value="24h">Last 24 Hours</option>
            </select>
            <select id="metricType">
                <option value="performance">Performance</option>
                <option value="predictions">ML Predictions</option>
                <option value="wallets">Wallet Activity</option>
            </select>
            <button id="toggleRealtime">Real-time Updates: ON</button>
        </div>
    `;

    attachControlListeners();
} 