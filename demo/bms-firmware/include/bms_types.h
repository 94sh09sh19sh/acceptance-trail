#ifndef BMS_TYPES_H
#define BMS_TYPES_H

/* Demo only, not design guidance. */

/* The two power paths the BMS can switch. "Closed" means current may flow. */
typedef enum {
    BMS_PATH_CHARGE = 0,
    BMS_PATH_DISCHARGE = 1,
    BMS_PATH_COUNT
} bms_path_t;

/* Result of reading one temperature sensor. */
typedef enum {
    BMS_SENSOR_OK = 0,
    BMS_SENSOR_OPEN,  /* wire break or unplugged sensor */
    BMS_SENSOR_SHORT  /* short circuit to ground */
} bms_sensor_status_t;

#endif /* BMS_TYPES_H */
