// Hand-crafted fixtures for weather adapter tests. Small and minimal —
// just enough fields to satisfy each schema. Edit deliberately if the
// upstream API contract changes.

export const openMeteoTwoDays = {
  daily: {
    time: ['2026-05-14', '2026-05-15'],
    temperature_2m_max: [85.1, 88.4],
    temperature_2m_min: [64.0, 66.0],
    relative_humidity_2m_mean: [52.0, 48.0],
    wind_speed_10m_max: [9.0, 11.0],
    wind_gusts_10m_max: [14.0, 18.0],
    precipitation_probability_max: [10.0, 5.0],
    precipitation_sum: [0.0, 0.0],
    dew_point_2m_mean: [60.0, 58.0],
  },
  hourly: {
    time: [
      '2026-05-14T00:00',
      '2026-05-14T12:00',
      '2026-05-15T00:00',
      '2026-05-15T12:00',
    ],
    temperature_2m: [70.0, 84.0, 72.0, 87.0],
    relative_humidity_2m: [55.0, 50.0, 51.0, 47.0],
    wind_speed_10m: [5.0, 9.0, 6.0, 11.0],
    wind_gusts_10m: [10.0, 14.0, 11.0, 18.0],
    precipitation_probability: [10.0, 5.0, 5.0, 0.0],
    precipitation: [0.0, 0.0, 0.0, 0.0],
    dew_point_2m: [60.0, 61.0, 58.0, 59.0],
  },
};

export const nwsPoints = {
  properties: {
    forecastHourly: 'https://api.weather.gov/gridpoints/EAX/41,67/forecast/hourly',
    timeZone: 'America/Chicago',
  },
};

export const nwsHourlyTwoDays = {
  properties: {
    periods: [
      {
        startTime: '2026-05-14T10:00:00-05:00',
        temperature: 78,
        temperatureUnit: 'F' as const,
        windSpeed: '5 to 10 mph',
        windGust: '15 mph',
        probabilityOfPrecipitation: { value: 20 },
        relativeHumidity: { value: 55 },
        dewpoint: { value: 15.5, unitCode: 'wmoUnit:degC' as const },
      },
      {
        startTime: '2026-05-14T11:00:00-05:00',
        temperature: 80,
        temperatureUnit: 'F' as const,
        windSpeed: '7 mph',
        windGust: null,
        probabilityOfPrecipitation: { value: 25 },
        relativeHumidity: { value: 52 },
        dewpoint: { value: 16.0, unitCode: 'wmoUnit:degC' as const },
      },
      {
        startTime: '2026-05-15T10:00:00-05:00',
        temperature: 81,
        temperatureUnit: 'F' as const,
        windSpeed: '10 mph',
        windGust: '20 mph',
        probabilityOfPrecipitation: { value: 30 },
        relativeHumidity: { value: 48 },
        dewpoint: { value: 14.5, unitCode: 'wmoUnit:degC' as const },
      },
    ],
  },
};
