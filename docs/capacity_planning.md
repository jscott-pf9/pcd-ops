# Design Goals
- Capacity planning is focus on overall cluster capacity and resource allocation, while rightsizing is focused on optimizing individual VMs for cost and performance.
- Capacity planning is more about forecasting and ensuring the cluster can meet future demands, while rightsizing is about analyzing current usage and making recommendations for adjustments.
- Capacity planning may involve scaling up or down the cluster, while rightsizing may involve resizing VMs or adjusting resource allocations.
- Capacity planning is more strategic and long-term, while rightsizing is more tactical and short-term.
- analysis should be performed by backend agent, but results should be visualized in "grafana style" dashboards and actionable recommendations should be provided in the PCD Ops UI, keeping the web app highly performant.

# AI Backend
- leveral local AI backend (Ollama) for processing and analyzing capacity planning data
- use AI to analyze historical usage data and predict future capacity needs
- pull data from prometheus and grafana to get accurate and up-to-date information about the cluster
- integrate machine learning algorithms for predictive analytics
- visualize predictions and actual usage trends
- enabled settings to configure AI backend.  Ollama is the default, but users can switch to OpenAI-compatible providers by setting the appropriate environment variables.

# Capacity Planning
- use AI to analyze historical usage data and predict future capacity needs
- pull data from prometheus and grafana to get accurate and up-to-date information about the cluster
-- integrate machine learning algorithms for predictive analytics
- visualize predictions and actual usage trends using tools like Grafana
- automate capacity adjustments based on real-time insights
- ensure compliance with organizational policies and resource constraints
- provide alerts and notifications for potential capacity issues or overutilization
- offer recommendations for optimizing resource allocation and improving efficiency
- provide recommendations for right-sizing VMs based on usage patterns

## Capacity Planning What-if Plans:
- allow users to create and compare different capacity planning scenarios based on various assumptions and parameters
- enable users to simulate the impact of different resource allocation strategies and scaling options
- enable ability to create multiple what-if "projects", for instead for each tenant (application or team) or for different time periods (e.g. next quarter vs next year)
- provide visualizations and reports to compare the outcomes of different what-if scenarios and make informed decisions (e.g. cost, performance, availability)

# UI
- use bar and line charts to show the capacity and usage of the cluster
- use different colors to differentiate between capacity and usage
- provide tooltips to show detailed information when hovering over the charts
- show future cpu, ram and disk storage needs based on historical data and trends
- highlight potential bottlenecks and underutilized resources

# AI Rightsizing
- analyze historical usage data to identify underutilized and overutilized VMs
- provide recommendations for right-sizing VMs based on usage patterns
- use AI to predict future resource needs and recommend adjustments accordingly
- enable risk assessment for right-sizing recommendations, considering potential performance impacts and cost savings
- provide a user-friendly interface for reviewing and implementing right-sizing recommendations
- integrate with existing VM management tools to facilitate the implementation of right-sizing recommendations