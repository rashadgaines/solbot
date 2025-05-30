const SimpleNeuralNetwork = require('./SimpleNeuralNetwork');

class EndpointPredictor {
    constructor() {
        this.model = new SimpleNeuralNetwork({
            inputFeatures: [
                'requestsPerMinute',
                'averageLatency',
                'failureRate',
                'timeOfDay',
                'dayOfWeek'
            ],
            hiddenLayers: [10, 5],
            outputFeatures: ['failureProbability', 'expectedLatency']
        });
        
        this.trainingData = [];
        this.TRAINING_INTERVAL = 3600000; // Train every hour
    }

    addDataPoint(metrics) {
        const dataPoint = {
            input: {
                requestsPerMinute: metrics.requestsPerMinute,
                averageLatency: metrics.averageLatency,
                failureRate: metrics.failureCount / (metrics.successCount + metrics.failureCount),
                timeOfDay: new Date().getHours(),
                dayOfWeek: new Date().getDay()
            },
            output: {
                failureProbability: metrics.consecutiveFailures > 0 ? 1 : 0,
                expectedLatency: metrics.averageLatency
            }
        };
        this.trainingData.push(dataPoint);
    }

    async predict(endpoint, metrics) {
        const prediction = await this.model.predict({
            requestsPerMinute: metrics.requestsPerMinute,
            averageLatency: metrics.averageLatency,
            failureRate: metrics.failureCount / (metrics.successCount + metrics.failureCount),
            timeOfDay: new Date().getHours(),
            dayOfWeek: new Date().getDay()
        });
        
        return {
            failureProbability: prediction.failureProbability,
            expectedLatency: prediction.expectedLatency
        };
    }
}

module.exports = EndpointPredictor;  