document.addEventListener('DOMContentLoaded', () => {
    const charts = initializeCharts();
    const socket = io();
    
    socket.on('analytics-update', (data) => {
        updateCharts(charts, data);
    });
});

function initializeCharts() {
    Chart.register(ChartJS.TimeScale);
    Chart.register(ChartJS.ZoomPlugin);
    Chart.register(ChartJS.AnnotationPlugin);

    return {
        performance: new Chart('performance-chart', {
            type: 'line',
            options: {
                responsive: true,
                scales: { y: { beginAtZero: true } }
            }
        }),
        // ... other chart initializations
    };
} 