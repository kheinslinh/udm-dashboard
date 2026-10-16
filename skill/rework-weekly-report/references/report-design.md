# Designing the report with the customer

## Questions to ask (or find in a meeting transcript)

1. **What decisions will this report support?** UDM: renegotiate retainers with clients who take
   more hours than costed; see whether the team uses its time well; prove scope creep to clients.
2. **Breakdowns that matter:** by client, by scope/service, by team, by person. Which first?
3. **Deliverables:** is "task completed in Rework" the right measure? How are revisions tracked
   (log titles? a stage? reopened tasks)?
4. **Retainers:** do they want budgets in Rework? (UDM: no — they compare hours to budgets
   elsewhere; the report only supplies actual hours per client and scope per month.)
5. **Internal work:** which service groups are internal (admin, clock-in, shoots, travel)?
6. **Forecast vs actual:** UDM dropped planned workload entirely and uses only real logged time.
   Ask before adding any "planned" numbers.
7. **Audience and tone:** who reads it, in which language, how long they'll look at it.

## Sections and their rules (as built)

| Section | Shown | Rule |
|---|---|---|
| 💰 Client hours (month-to-date) | Top 5 clients, +hours this week, top 3 scopes each, biggest jump | Internal groups excluded |
| 👥 Team time (this week) | Total, vs last week, people logged / total, avg vs benchmark, by team, top 5 people, who logged nothing | Benchmark = 8h × Mon–Fri days in the week |
| ✅ Deliverables | Completed this week, done / total, overdue with top 3 clients | Overdue = not done, not cancelled, deadline passed |
| 🔁 Revisions (this week) | Logs, tasks, hours and share, most-revised tasks | Log title or task name matches revision / rev N / amend / re-edit / changes |
| 🕘 Internal time | One line | Internal groups + clock-in tasks |
| 🧹 Data hygiene | Logs with no title of their own, timers >12h left out | "No title" = Rework's auto title (`[CODE-1] Task` or `Task · 9 Oct, 03:25`) |

Week = 7 days before the run day (Friday–Thursday). Month-to-date = 1st of the month to the day
before. Monthly summary = whole previous month, sent on the first Friday of a month (day ≤ 7).

## Message shape (English, under 2,000 characters; longer messages split on line breaks)

```
📊 **<Name> Weekly Report — Week 42** (9–15 Oct 2026)
_Rework time logs · month-to-date = 1–15 Oct 2026_

**💰 Client hours (month-to-date)**
1. <Client> — **152.9h** (+48.5h this week)
   └ Social 57.8h · Digital Ads 33.6h · Performance 31.3h
...
📈 Most hours this week: <Client> +65.1h

**👥 Team time (this week)**
- **225.9h** logged by 25/30 people (-12.1h vs last week) · avg 7.5h vs 40h benchmark
- Creative 80.1h · Content & Social 63.8h · ...
- Top: <5 people>
- ⚠️ No hours logged: <names>

**✅ Deliverables**
- 97 tasks completed this week · 210 done of 513 total
- 🔴 **152 overdue** · most: <client> (30), ...

**🔁 Revisions (this week)**
- 90 revision logs on 36 tasks · 117.3h (52% of hours)
- Most revised: "<task>" (<client>, 7) · ...

**🕘 Internal time:** 7.1h (clock-in, admin, internal)

**🧹 Data hygiene**
- 81 of 181 time logs have no title · 1 timer >12h left out (31.0h)
🔗 Full dashboard: <url>
```

Easy changes customers ask for: number of top clients (`top_clients` in `render.weekly`), hiding
the "no hours logged" names, client display names (rename the service group in Rework, or add a
mapping in `render.py`).
