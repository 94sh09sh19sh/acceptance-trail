#ifndef BMS_CONFIG_H
#define BMS_CONFIG_H

/*
 * Demo firmware for the Proof of Done showcase: a fictional battery
 * management module for an electric motorcycle.
 * Demo only, not design guidance. Every number in this project is illustrative.
 *
 * Unit convention: temperatures are signed integers in deci-degrees Celsius
 * (250 means 25.0 C).
 */

#define BMS_SENSOR_COUNT    4u    /* temperature sensors, one per cell group */
#define BMS_TICK_PERIOD_MS  100u  /* bms_tick() is called once every 100 ms */
#define BMS_NO_SENSOR       0xFFu /* "no sensor" marker for log entries */

#endif /* BMS_CONFIG_H */
