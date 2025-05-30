class SimpleNeuralNetwork {
    constructor(config) {
        this.inputFeatures = config.inputFeatures;
        this.outputFeatures = config.outputFeatures;
        this.hiddenLayers = config.hiddenLayers;
        this.weights = this.initializeWeights();
        this.learningRate = 0.01;
    }

    initializeWeights() {
        // Simple weight initialization for demo
        return {
            input: Array(this.inputFeatures.length).fill().map(() => Math.random() - 0.5),
            hidden: this.hiddenLayers.map(size => Array(size).fill().map(() => Math.random() - 0.5)),
            output: Array(this.outputFeatures.length).fill().map(() => Math.random() - 0.5)
        };
    }

    predict(input) {
        // Simple forward pass for demo
        const normalized = this.normalize(input);
        return {
            failureProbability: Math.max(0, Math.min(1, normalized.reduce((sum, val, i) => 
                sum + val * this.weights.input[i], 0))),
            expectedLatency: normalized.reduce((sum, val, i) => 
                sum + val * this.weights.input[i], 0) * 1000
        };
    }

    normalize(input) {
        return this.inputFeatures.map(feature => {
            const value = input[feature];
            switch(feature) {
                case 'timeOfDay': return value / 24;
                case 'dayOfWeek': return value / 7;
                case 'requestsPerMinute': return value / 1000;
                case 'averageLatency': return value / 2000;
                case 'failureRate': return value;
                default: return value;
            }
        });
    }
}

module.exports = SimpleNeuralNetwork;  