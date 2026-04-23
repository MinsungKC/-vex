# VEX Event Team Lookup

A simple static website for looking up VEX teams by event code using the RobotEvents API v2.

## Setup

1. **Get an API Token**: Visit [RobotEvents API Access Request](https://www.robotevents.com/api/v2/accessRequest/create) and request access to the API.

2. **Add Your Token**: Open `script.js` and replace the placeholder with your actual API token.

## Features

- **Event Search**: Find events by SKU code (e.g., `RE-VRC-23-1488`)
- **Complete Team List**: Fetches all registered teams (handles pagination automatically)
- **Detailed Information**: Shows team numbers, names, robot names, organizations, locations, grades, and registration status
- **Event Details**: Displays program, season, level, dates, and venue information
- **Responsive Design**: Works on desktop and mobile devices

## Files

- `index.html` — main page with search form
- `style.css` — responsive styling with mobile support
- `script.js` — API integration with pagination handling

## Usage

1. Open `index.html` in your browser.
2. Enter a VEX event code, for example `RE-VRC-23-1488`.
3. Click `Search teams`.

## API Endpoints Used

- `GET /events?sku[]={eventCode}` — Search for events by SKU
- `GET /events/{id}/teams?page={page}&per_page=250` — Get paginated team list

## Notes

- Requires a valid RobotEvents API token for authentication
- Handles API pagination automatically to fetch all teams
- Dates are formatted for better readability
- Make sure your browser has network access to the API
