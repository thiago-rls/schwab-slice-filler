# Slice Filler

Fills Schwab's trade ticket with a list of tickers and dollar amounts. It never clicks Review or Place Order.
Schwab killed Slices. Even though it wasn't great, it let you buy fractional shares of multiple companies at once.

> **Not affiliated with, endorsed by, or supported by Charles Schwab & Co., Inc.** This is an independent personal project.

## It can break at any time

Schwab doesn't offer a public interface for its website. This extension works by finding fields on Schwab's trade page, so any change Schwab makes to that page can stop it from working, or make it fill a field incorrectly, without warning.

**Always check every order before you click Review and Place Order.** Compare the symbol, Buy/Sell, dollar amount and order type on each row, and make sure Schwab's total estimated amount matches your total. Use it at your own risk.

## Install (Chrome)
1. Unzip this folder somewhere permanent.
2. Open chrome://extensions and turn on Developer mode.
3. Click "Load unpacked" and select the folder.
4. Open client.schwab.com, then go to Trade. The panel appears at the bottom right.

## Use
1. Pick a preset, enter the total, and choose Equal split or By percent.
2. In Schwab, open the trade ticket and click Clear All so it is empty.
3. Click Fill order. The panel adds one order per ticker: Buy, Dollars, the amount, Market, Day.
4. Check every row, then click Review in Schwab yourself.

## What it can access
- Runs only on https://client.schwab.com/app/trade/*
- Only permission: "storage", which keeps your presets on this computer.
- No network requests, and it doesn't read balances or account numbers.

## Backup
Use the ⋯ menu in the panel header: Export presets saves a .json file; Import presets loads one back. A preset with the same name is replaced; others are added.

# Known limitations
- Tested only with Schwab's stock/ETF ticket in Chrome, in November 2026.
- The number of orders Schwab allows on one ticket is unknown. The extension stops and tells you if "+ Add Order" disappears.
- Dollar-amount (fractional) orders are available only for symbols Schwab supports.

