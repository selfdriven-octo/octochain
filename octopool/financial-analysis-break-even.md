# Break-Even Business Case: Running a Cardano SPO on AWS

## Executive Summary
This document evaluates the costs, revenue potential, and break-even point for operating a Cardano Stake Pool Operator (SPO) on AWS. The analysis considers infrastructure costs, expected rewards, and delegation requirements to achieve profitability.

---

## Costs of Operating a Cardano Stake Pool

### Fixed Monthly Costs
To operate a Cardano stake pool, the following infrastructure is required:

| Component             | Specification                | Cost/Month (USD) |
|-----------------------|-----------------------------|------------------|
| **Block Producer**    | t3.xlarge (4 vCPUs, 16 GB)  | ~$97            |
| **Relay Nodes (2)**   | t3.large (2 vCPUs, 8 GB)    | ~$86            |
| **Storage**           | 200 GB GP3 SSD per node     | ~$60            |
| **Bandwidth**         | 500 GB per node (total 1.5 TB) | ~$150         |

**Total Monthly Costs**: **~$393**

---

## Revenue Potential

### Cardano Rewards System
Rewards depend on the total stake delegated to your pool and your pool's ability to produce blocks. For this analysis:
- **Delegation**: 1 million ADA
- **Expected Blocks per Epoch**: ~0.88 (calculated as a proportion of total stake)
- **Rewards per Block**: ~532 ADA
- **Epochs per Month**: ~6

#### Monthly Rewards Estimation
| Metric                            | Value                |
|-----------------------------------|----------------------|
| **Rewards per Block**             | ~532 ADA            |
| **Blocks per Epoch**              | ~0.88               |
| **Epochs per Month**              | ~6                  |
| **Total Monthly Rewards (ADA)**   | ~2,809 ADA          |

---

## Break-Even Analysis

### Conversion of ADA to USD
- Current ADA Price: **$0.30** (example; adjust based on market rates)
- Monthly Rewards (USD): \( 2,809 \times 0.30 = 842.70 \)

### Profitability Calculation
| Metric                      | Value (USD)    |
|-----------------------------|----------------|
| **Monthly Revenue**         | ~$843          |
| **Monthly Costs**           | ~$393          |
| **Net Monthly Profit**      | ~$450          |

---

## Delegation Requirements for Break-Even

To calculate the rewards needed to cover monthly costs:

1. Rewards Needed (ADA):
   - Formula: Rewards Needed (ADA) = Monthly Costs (USD) / ADA Price
   - Substituting values: 393 / 0.30 ≈ 1,310 ADA/month

2. Required Delegation (ADA):
   - Formula: Required Delegation (ADA) = Rewards Needed / Rewards per ADA Staked
   - Rewards per ADA Staked = Total Monthly Rewards / Total Delegation
   - Substituting values: 1,310 / (2,809 / 1,000,000) ≈ 466,464 ADA

**Break-Even Delegation:** ~470,000 ADA (at a price of $0.30/ADA).

---

## Assumptions and Risks
1. **ADA Price Volatility**: Changes in ADA price affect profitability.
2. **Delegation Stability**: Rewards depend on the consistency of stake delegation.
3. **AWS Cost Variability**: Spot or reserved instances may alter costs.

---

## Conclusion
Operating a Cardano SPO on AWS can be profitable with sufficient delegation. At 1 million ADA delegated and a price of $0.30 per ADA, the pool generates ~$450 in net profit monthly. The break-even delegation point is approximately 470,000 ADA.

By optimizing AWS costs and increasing delegation, profitability can be enhanced. However, price volatility and delegation stability remain critical risks to consider.

