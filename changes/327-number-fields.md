---
section: fixed
---

- **Number fields can be cleared and typed over.** Deleting the last digit of a number setting left a "0" behind, so typing 2 gave "02", and on a phone the first digit was hard to change. Every number field in CodeDen (factory limits, merge checks, the scout, budgets, model prices, automation guards, hook timeouts and settings) now works the same way:
  - While you type, the field keeps your text, so it can be empty and a new number replaces the old one. Focusing it selects its number, so you can type straight over it.
  - When you leave the field or press Enter, it tidies up: "05" becomes 5, a number above or below what the setting takes is set to the highest or lowest allowed with a short note ("The most is 8."), and an empty or unreadable entry goes back to the number from before your edit, with a note. A field that can be empty, such as "No limit", saves as empty.
  - Phones show a number keyboard, and the decimal keyboard where a fraction makes sense (budgets and prices in USD), which take a dot or a comma.
