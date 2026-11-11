/* Tests for the ADC to temperature conversion (bms_sensor.c). */
#include "bms_sensor.h"
#include "test_framework.h"

TEST(test_sensor_adc_table_point_converts_exactly)
{
    int16_t temp_dc = 0;
    CHECK_EQ(BMS_SENSOR_OK, bms_sensor_from_adc(512, &temp_dc));
    CHECK_EQ(250, temp_dc);
    CHECK_EQ(BMS_SENSOR_OK, bms_sensor_from_adc(310, &temp_dc));
    CHECK_EQ(450, temp_dc);
}

TEST(test_sensor_adc_interpolates_between_points)
{
    int16_t temp_dc = 0;
    /* 411 counts is half way between the 25.0 C and 45.0 C table points. */
    CHECK_EQ(BMS_SENSOR_OK, bms_sensor_from_adc(411, &temp_dc));
    CHECK_EQ(350, temp_dc);
}

TEST(test_sensor_adc_temperature_never_falls_as_counts_fall)
{
    int16_t previous = -32768;
    for (uint16_t raw = 934; raw >= 35; raw = (uint16_t)(raw - 11)) {
        int16_t temp_dc = 0;
        CHECK_EQ(BMS_SENSOR_OK, bms_sensor_from_adc(raw, &temp_dc));
        CHECK(temp_dc >= previous);
        previous = temp_dc;
    }
}

TEST(test_sensor_adc_clamps_counts_outside_the_table)
{
    int16_t temp_dc = 0;
    CHECK_EQ(BMS_SENSOR_OK, bms_sensor_from_adc(1000, &temp_dc));
    CHECK_EQ(-200, temp_dc);
    CHECK_EQ(BMS_SENSOR_OK, bms_sensor_from_adc(20, &temp_dc));
    CHECK_EQ(1250, temp_dc);
}

TEST(test_sensor_adc_reports_open_circuit)
{
    int16_t temp_dc = 0;
    CHECK_EQ(BMS_SENSOR_OPEN, bms_sensor_from_adc(1023, &temp_dc));
    CHECK_EQ(BMS_SENSOR_OPEN, bms_sensor_from_adc(1015, &temp_dc));
    CHECK_EQ(BMS_SENSOR_OK, bms_sensor_from_adc(1014, &temp_dc));
}

TEST(test_sensor_adc_reports_short_circuit)
{
    int16_t temp_dc = 0;
    CHECK_EQ(BMS_SENSOR_SHORT, bms_sensor_from_adc(0, &temp_dc));
    CHECK_EQ(BMS_SENSOR_SHORT, bms_sensor_from_adc(8, &temp_dc));
    CHECK_EQ(BMS_SENSOR_OK, bms_sensor_from_adc(9, &temp_dc));
}
