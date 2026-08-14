# Offline AI Integration – Android Hardware POS

## 1. Objective

Integrate **fully local/offline AI** into the Android POS application.

The AI should:

- Run entirely on the tablet.
- Require **no external AI API calls**.
- Continue working without internet.
- Keep sales, stock, customer and product data on-device.
- Understand natural-language requests from POS users.
- Use the existing POS/database logic to retrieve accurate information.
- Never be responsible for critical calculations such as totals, VAT, stock balances or payment processing.

The AI is primarily an **intelligent interface to the POS**, rather than the POS business logic itself.

---

## 2. Proposed Architecture

```text
┌──────────────────────────────────────┐
│             POS USER                 │
│                                      │
│ "Show Bosch grinders under R1500"   │
└─────────────────┬────────────────────┘
                  ↓
┌──────────────────────────────────────┐
│          LOCAL AI LAYER              │
│                                      │
│  FunctionGemma / Gemma               │
│                                      │
│  Understands user intention          │
└─────────────────┬────────────────────┘
                  ↓
           Function / Tool Call
                  ↓
┌──────────────────────────────────────┐
│         POS SERVICE LAYER            │
│                                      │
│ searchProducts()                     │
│ getStock()                           │
│ getPrice()                           │
│ getSales()                           │
│ findAlternatives()                   │
│ etc.                                 │
└─────────────────┬────────────────────┘
                  ↓
┌──────────────────────────────────────┐
│        ROOM / SQLITE DATABASE        │
│                                      │
│ Products • Stock • Sales             │
│ Customers • Suppliers • Prices      │
└──────────────────────────────────────┘
```

**Key principle:**

> **AI interprets the question. The POS determines the answer.**

The LLM should never be considered the authoritative source for inventory, prices, sales figures, VAT, transaction totals, etc.

---

## 3. Local AI Runtime

Recommended Android stack:

**Kotlin / Android → LiteRT-LM → Gemma models**

The initial target hardware should preferably have:

- **8 GB physical RAM minimum**
- 128 GB+ storage
- Modern 64-bit ARM processor
- Good GPU/OpenCL/Vulkan support
- Android 15+
- Preferably UFS storage

The **Lenovo Idea Tab with Dimensity 6300 + 8 GB RAM + 128 GB UFS 2.2** currently looks like a reasonable reference/development device.

---

## 4. Two AI Components

I recommend separating the AI functionality into two components rather than asking one large LLM to do everything.

### A. Function/Intent Model

Start with **FunctionGemma 270M** or a similarly small local model.

Its purpose is to translate natural language into structured POS operations.

User:

> "How many Bosch 750W grinders do we have?"

AI interpretation:

```json
{
  "function": "getStock",
  "arguments": {
    "query": "Bosch 750W grinder"
  }
}
```

The application executes the function against the local database.

This model can remain loaded because it is relatively small.

### B. Local Embedding Model

Use a small embedding model, potentially **EmbeddingGemma**, for semantic product search.

This allows users to find products even when they do not know the exact catalogue description.

---

## 5. POS Functions Exposed to AI

Create a controlled function/tool layer between AI and the application.

For example:

```text
searchProducts(query, filters)

getProduct(productId)

getPrice(productId)

getStock(productId, branchId)

findAlternatives(productId)

getSales(dateFrom, dateTo)

getTopSellingProducts(dateFrom, dateTo)

getLowStockItems()

searchCustomer(query)

getCustomerPurchases(customerId)

getDepartmentSales(department, dateFrom, dateTo)
```

The LLM **must not have direct database access**.

It requests an approved function and the application validates and executes it.

---

## 6. Semantic Product Search

This could be particularly valuable for a hardware store.

Normal SQL search works well when the cashier knows the product name:

> "Bosch GSB 13 RE"

But customers often describe products differently:

> "That plastic thing that makes a 25mm pipe fit onto a 20mm pipe."

Add a local embedding model, potentially **EmbeddingGemma**, to handle this.

Conceptually:

```text
Customer description
        ↓
Embedding model
        ↓
Vector
        ↓
Local vector similarity search
        ↓
Best matching catalogue products
        ↓
POS displays results
```

Product records can have searchable text constructed from:

```text
Product name
Brand
Department
Category
Description
Specifications
Tags
Synonyms
```

The embeddings can be generated and stored locally.

---

## 7. Larger LLM — Optional Second Stage

A larger model such as **Gemma 4 E2B** could eventually provide richer conversational and analytical functionality.

For example:

> "How is the plumbing department performing compared with last month?"

The LLM should **not calculate this from thousands of transactions**.

Instead:

```text
User question
      ↓
AI
      ↓
getDepartmentSales(...)
      ↓
POS/database performs calculations
      ↓
Structured result:

Current month: R211,840
Previous month: R183,250
Change: +15.6%
      ↓
LLM
      ↓
Natural-language explanation
```

This keeps the result accurate while allowing the LLM to provide a useful explanation.

The larger LLM should be considered **optional for the first release**, particularly until performance has been benchmarked on the target tablets.

---

## 8. Safety and Permissions

Initially, AI functions should preferably be **read-only**.

Allow operations such as:

```text
✓ Search products
✓ Check prices
✓ Check stock
✓ Search transactions
✓ Generate sales summaries
✓ Find customers
✓ Find alternative products
```

Do **not** initially allow autonomous:

```text
✗ Change price
✗ Change stock
✗ Delete transactions
✗ Process refunds
✗ Cancel invoices
✗ Change customer balances
✗ Process payments
```

If write operations are introduced later:

```text
AI request
     ↓
Validate parameters
     ↓
Show user confirmation
     ↓
User approves
     ↓
Normal POS business logic
     ↓
Database change
     ↓
Audit log
```

AI should never bypass existing POS authorization or permission rules.

---

## 9. Example Complete Interaction

Cashier asks:

> "Show me Makita cordless drills under R2,500 that we have in stock."

Function model determines:

```json
{
  "function": "searchProducts",
  "arguments": {
    "brand": "Makita",
    "category": "cordless drill",
    "maxPrice": 2500,
    "inStock": true
  }
}
```

POS performs the database query:

```text
Makita DDF482
R2,299
Stock: 8

Makita HP333
R1,899
Stock: 3
```

UI can simply display those results.

No hallucinated products, prices or inventory quantities should come from the LLM.

---

## 10. Offline-First Design

The complete AI path should work locally:

```text
               ANDROID TABLET

┌────────────────────────────────────┐
│                                    │
│             POS UI                 │
│               ↓                    │
│        Local AI Runtime            │
│               ↓                    │
│      Function/Intent Model         │
│          ↙           ↘             │
│  POS Functions     Embeddings      │
│       ↓                ↓           │
│    SQLite        Vector Search     │
│       ↓                ↓           │
│          POS Results               │
│                                    │
└────────────────────────────────────┘

             NO INTERNET
             REQUIRED
```

Internet/5G can still be used for normal POS synchronization, backups, software updates, central reporting, etc., but **AI inference should not depend on connectivity**.

---

## 11. Recommended Development Phases

### Phase 1 — Proof of Concept

Implement:

- LiteRT-LM
- FunctionGemma
- 5–10 read-only POS functions
- Test product database

Prove that the following pipeline works reliably:

**Natural language → function → database → result**

### Phase 2 — Intelligent Product Search

Add:

- Local embeddings/vector search
- Product synonyms
- Natural-language catalogue queries
- Ranking of likely product matches

### Phase 3 — Advanced Assistant

Benchmark **Gemma 4 E2B** on the 8 GB target tablet.

If performance is acceptable, add:

- Conversational answers
- Product comparisons
- Sales summaries
- Department comparisons
- More complex analytical questions

### Phase 4 — Controlled Actions

Only after the read-only system is proven, consider AI-initiated write operations with:

- User permissions
- Parameter validation
- Explicit confirmation
- Existing POS business rules
- Audit logging

---

## 12. Target Hardware

For the proposed architecture, the recommended baseline is:

| Component | Recommended |
|---|---|
| RAM | **8 GB physical minimum** |
| Storage | **128 GB+** |
| CPU | Modern 64-bit ARM |
| GPU | Good OpenCL/Vulkan support |
| Storage type | Preferably UFS |
| Android | Android 15+ preferred |
| Connectivity | Wi-Fi; 4G/5G useful for POS sync |
| Screen | Approximately 11"+ |

### Current Reference Device

**Lenovo Idea Tab**

- MediaTek Dimensity 6300
- 8 GB LPDDR4X RAM
- 128 GB UFS 2.2
- Mali-G57 MC2 GPU
- Android 15 or later
- 5G
- microSD support
- 11-inch 2560×1600 display

This is a more suitable development target for local AI than the 6 GB Galaxy Tab A11+ discussed previously.

---

## 13. Performance Testing Before Deployment

Before purchasing tablets in volume, test a single reference device with realistic data.

Suggested test dataset:

- 10,000–50,000 products
- Product descriptions and specifications
- Realistic inventory records
- Sales history
- Local embeddings
- FunctionGemma loaded
- Full POS application running simultaneously

Measure:

1. AI response latency
2. RAM consumption
3. Model loading time
4. Product search latency
5. Database query latency
6. Thermal throttling during repeated AI queries
7. Battery consumption
8. Stability during a full working day
9. Android process/memory pressure
10. Performance while POS peripherals are connected

---

## 14. Most Important Development Principle

The team should think of the architecture as:

```text
AI
=
Language / Intelligence Layer

POS Services
=
Business Rules

Database
=
Source of Truth
```

**Not:**

```text
AI = POS Brain
```

This separation makes the system:

- Faster
- Safer
- Easier to test
- Easier to debug
- Less prone to hallucinations
- More deterministic
- Practical on an 8 GB Android tablet
- Easier to upgrade to different AI models later

The AI model should therefore remain **replaceable**. POS business logic should not depend on a specific LLM.

---

## Recommended Initial Stack

```text
Android / Kotlin
        ↓
POS UI
        ↓
AI Orchestration Layer
        ↓
LiteRT-LM
        ↓
FunctionGemma 270M
        ↓
Approved POS Functions
        ↓
Room / SQLite

        +

Local Embedding Model
        ↓
Vector Product Search

        +

Optional Later:
Gemma 4 E2B
for advanced conversational analysis
```

### Initial Development Goal

Build a reliable offline prototype where a cashier can ask:

> "Show me Makita cordless drills under R2,500 that are currently in stock."

and the system reliably performs:

```text
Natural-language request
        ↓
Local intent/function model
        ↓
Validated POS function
        ↓
Local database query
        ↓
Accurate POS result
```

with **no external AI API call and no internet requirement**.
