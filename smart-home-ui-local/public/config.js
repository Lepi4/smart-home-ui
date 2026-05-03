window.PLAN_CONFIG = {
  rooms: [
    { id:'overview', label:'Общий план' },
    { id:'living', label:'Гостиная', image:'assets/rooms/living.webp', x:39.5, y:55.5, w:29, h:39, contentBox:{x:20.81,y:2.83,w:55.44,h:94.42}, temp:'sensor.wb_msw_v4_179_temperature', humidity:'sensor.wb_msw_v4_179_humidity' },
    { id:'kitchen', label:'Кухня', image:'assets/rooms/kitchen.webp', x:32.0, y:19.0, w:14, h:16, contentBox:{x:19.44,y:11.08,w:66.25,h:83.92}, temp:'sensor.wb_msw_v4_169_temperature', humidity:'sensor.wb_msw_v4_169_humidity' },
    { id:'bedroom1', label:'Спальня левая', image:'assets/rooms/bedroom1.webp', x:80.8, y:38.5, w:25, h:25, contentBox:{x:13.69,y:6.25,w:74.00,h:93.00}, temp:'sensor.wb_msw_v4_74_temperature', humidity:'sensor.wb_msw_v4_74_humidity' },
    { id:'bedroom2', label:'Спальня правая', image:'assets/rooms/bedroom2.webp', x:83.0, y:73.0, w:23, h:25, contentBox:{x:11.88,y:3.17,w:80.74,h:94.16}, temp:'sensor.wb_msw_v4_177_temperature', humidity:'sensor.wb_msw_v4_177_humidity' },
    { id:'office', label:'Кабинет', image:'assets/rooms/office.webp', x:61.5, y:72.5, w:11, h:18, contentBox:{x:21.25,y:7.75,w:66.50,h:87.42}, temp:'sensor.wb_m1w2_31_external_sensor_2', humidity:'' },
    { id:'mainbath', label:'Основной санузел', image:'assets/rooms/mainbath.webp', x:63.0, y:34.8, w:15, h:20, contentBox:{x:21.31,y:8.00,w:63.12,h:87.83}, temp:'sensor.wb_msw_v4_150_temperature', humidity:'sensor.wb_msw_v4_150_humidity' },
    { id:'guestbath', label:'Гостевой санузел', image:'assets/rooms/guestbath.webp', x:15.2, y:52.0, w:14, h:20, contentBox:{x:23.69,y:7.17,w:56.94,h:87.58}, temp:'sensor.wb_msw_v4_168_temperature', humidity:'sensor.wb_msw_v4_168_humidity' },
    { id:'entrance', label:'Прихожая', image:'assets/rooms/entrance.webp', x:16.0, y:34.0, w:14, h:20, contentBox:{x:25.75,y:5.25,w:52.00,h:90.83}, temp:'sensor.wb_m1w2_201_external_sensor_1', humidity:'' },
    { id:'wardrobe', label:'Гардероб', image:'assets/rooms/wardrobe.webp', x:53.8, y:45.0, w:11, h:22, contentBox:{x:26.10,y:5.80,w:55.81,h:90.61}, temp:'sensor.wb_w1_28_0000005452ba' },
    { id:'laundry', label:'Постирочная / котельная', image:'assets/rooms/laundry.webp', x:24.0, y:78.5, w:25, h:20, contentBox:{x:17.47,y:15.93,w:68.44,h:73.55}, temp:'sensor.wb_m1w2_173_external_sensor_2', humidity:'' },
    { id:'corridor', label:'Коридор', image:'assets/rooms/corridor.webp', x:64.0, y:55.5, w:17, h:18, contentBox:{x:26.50,y:8.50,w:53.25,h:91.50} }
  ],
  pollIntervalMs: 6000
};
