import { React } from 'jimu-core';
import { DatePicker, LocalizationProvider, PickersDay, PickersDayProps } from '@mui/x-date-pickers';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import esriRequest from 'esri/request';
import { useState, useEffect } from 'react';
import { format } from 'date-fns';

/**
 *  Searches the Sentinel Hub catalog API for a given extent and month 
 *  @param monthStart the first date of the month currently in the calendar view
 *  @param extent Current map extent
 *  @param accessToken Sentinel Hub access token 
 *  @param collectionID Sentinel Hub Collection ID as supplied in the widget configuration 
 *  @returns {Promise<string[]>} An object that contains the list of dates with available data
 */

async function getAvailableDates(monthStart: Date, extent: any, accessToken: string, collectionID: string): Promise<string[]> {
    const endpoint = "https://services.sentinel-hub.com/api/v1/catalog/1.0.0/search";

    const monthEnd = new Date(monthStart);
    monthEnd.setMonth(monthEnd.getMonth() + 1);
    monthEnd.setDate(0);

    if (extent instanceof Promise) {
        extent = await extent;
    }

    console.log('Original Extent:', extent);
    console.log('Extent Constructor:', extent.constructor.name);

    let extent_json;
    if (extent && typeof extent.toJSON === 'function') {
        extent_json = extent.toJSON();
    } else {
        extent_json = {
            xmin: extent.xmin,
            ymin: extent.ymin,
            xmax: extent.xmax,
            ymax: extent.ymax,
            spatialReference: extent.spatialReference.toJSON()
        };
    }
    const bbox = [extent_json.xmin, extent_json.ymin, extent_json.xmax, extent_json.ymax];

    const basePayload = {
        "collections": [
            `byoc-${collectionID}`
        ],
        "datetime": `${monthStart.toISOString()}/${monthEnd.toISOString()}`,
        "bbox": bbox,
        "limit": 100
    };

    const options = {
        method: "post" as const,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
        responseType: "json" as const,
        body: ''
    };

    let uniqueDates: string[] = [];
    let next: number | undefined = undefined;

    try {
        while (true) {
            const payload = { ...basePayload, next };
            options.body = JSON.stringify(payload);

            const response = await esriRequest(endpoint, options);
            const timestamps: string[] = response.data.features.map((feature: any) => feature.properties.datetime);
            uniqueDates.push(...timestamps.map((timestamp: string) => timestamp.split('T')[0]));

            // Check if there is a next page
            const context = response.data.context;
            if (context && context.next) {
                next = context.next;
            } else {
                break;
            }
        }

        // Remove duplicates
        uniqueDates = [...new Set(uniqueDates)];
        return uniqueDates;
    } catch (error) {
        console.error('Error fetching dates:', error);
        throw error;
    }
}

interface DateSelectorProps {
    selectedDate: Date | null;
    endDate: Date | null;
    accessToken: string;
    handleDateChange: (selectedDate: Date | null) => void;
    handleSecondDateChange: (endDate: Date | null) => void;
    collectionID: string;
    getMapExtent: (wkid: number) => any;
}

interface CustomDayProps extends PickersDayProps<Date> {
    availableDates: string[];
    selectedDate: Date | null;
}

const CustomDay: React.FC<CustomDayProps> = (props) => {
    const { day, availableDates, selectedDate, ...other } = props;
    const dateStr = format(day, "yyyy-MM-dd");
    const isSelected = availableDates.includes(dateStr);
    const dayStyles = {
        backgroundColor: isSelected ? "#b3e5fc" : "inherit",
        borderRadius: "50%",
        width: "36px",
        height: "36px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
    };

    return (
        <PickersDay
            {...other}
            day={day}
            selected={isSelected || (selectedDate && day.getTime() === selectedDate.getTime())}
            style={dayStyles}
        />
    );
};

const DateSelector: React.FC<DateSelectorProps> = ({ selectedDate, endDate, accessToken, handleDateChange, handleSecondDateChange, collectionID, getMapExtent }) => {
    const [availableDates, setAvailableDates] = useState<string[]>([]);
    const startDate = new Date();

    useEffect(() => {
        const mapExtent = getMapExtent(4326);
        if (!mapExtent) {
            console.error("Unable to determine map extent");
            return;
        }

        const monthStart = new Date();
        monthStart.setDate(1);
        const monthEnd = new Date(monthStart);
        monthEnd.setMonth(monthEnd.getMonth() + 1);
        monthEnd.setDate(0);

        if (accessToken && collectionID) {
            getAvailableDates(monthStart, mapExtent, accessToken, collectionID).then(dates => {
                setAvailableDates(dates);
            });
        }
    }, [accessToken, collectionID]);

    const handleMonthChange = (date: Date) => {
        const mapExtent = getMapExtent(4326);
        if (!mapExtent) {
            return;
        }
        const monthStart = new Date(date);
        monthStart.setDate(1);
        const monthEnd = new Date(monthStart);
        monthEnd.setMonth(monthEnd.getMonth() + 1);
        monthEnd.setDate(0);
        getAvailableDates(monthStart, mapExtent, accessToken, collectionID).then(dates => {
            setAvailableDates(dates);
        });
    };

    return (
        <LocalizationProvider dateAdapter={AdapterDateFns}>
            <div>
                <DatePicker
                    label="Start Date"
                    onChange={(newDate) => handleDateChange(newDate)}
                    value={selectedDate}
                    onMonthChange={handleMonthChange}
                    slots={{ day: (dayProps) => <CustomDay {...dayProps} availableDates={availableDates} selectedDate={selectedDate} /> }}
                    slotProps={{
                        textField: {
                            helperText: 'Select a date to view data',
                        }
                    }}
                />
                <DatePicker
                    label="End Date"
                    onChange={(newDate) => handleSecondDateChange(newDate)}
                    value={endDate}
                    onMonthChange={handleMonthChange}
                    slots={{ day: (dayProps) => <CustomDay {...dayProps} availableDates={availableDates} selectedDate={selectedDate} /> }}
                />
            </div>
        </LocalizationProvider>
    );
};

export default DateSelector;
