(() => {
  const trackLayer = L.layerGroup().addTo(map);
  const endpointLayer = L.layerGroup().addTo(map);
  const stationLayer = L.layerGroup().addTo(map);
  const selectionLayer = L.layerGroup().addTo(map);
  const status = message => { document.getElementById('status').textContent = message; };
  const metersPerLat = 111132;
  const metersPerLon = 111320 * Math.cos(38.9 * Math.PI / 180);
  const toMeters = p => ({x:p.lng * metersPerLon, y:p.lat * metersPerLat});
  const toLatLng = p => L.latLng(p.y / metersPerLat, p.x / metersPerLon);
  let selectedLine = data.lines[0]?.id || null;
  let activeTool = 'none';
  let startNode = null;
  let undoStack = [];
  let redoStack = [];

  function speedCap(type) { return type === 'Light rail' ? 40 : type === 'Commuter rail' ? 65 : 55; }
  function sampleBezier(a,b,c,d,steps=36) {
    const out=[];
    for(let i=0;i<=steps;i++) { const t=i/steps,u=1-t; out.push({x:u*u*u*a.x+3*u*u*t*b.x+3*u*t*t*c.x+t*t*t*d.x,y:u*u*u*a.y+3*u*u*t*b.y+3*u*t*t*c.y+t*t*t*d.y}); }
    return out;
  }
  function speedFor(samples, cap) {
    let slowest=cap;
    for(let i=1;i<samples.length-1;i++) {
      const a=samples[i-1],b=samples[i],c=samples[i+1];
      const ab=Math.hypot(b.x-a.x,b.y-a.y),bc=Math.hypot(c.x-b.x,c.y-b.y),ca=Math.hypot(a.x-c.x,a.y-c.y);
      const cross=Math.abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x));
      if(cross<.001) continue;
      const radius=ab*bc*ca/(2*cross);
      slowest=Math.min(slowest,Math.max(5,Math.floor(Math.sqrt(.8*radius)*2.236936/5)*5));
    }
    return slowest;
  }
  function makeSegment(start,end,type,alignment) {
    const a=toMeters(start),d=toMeters(end),dx=d.x-a.x,dy=d.y-a.y,chord=Math.hypot(dx,dy);
    const ux=dx/(chord||1),uy=dy/(chord||1),nx=-uy,ny=ux;
    const ratio={Straight:0,Gentle:.045,Standard:.085,Tight:.13}[alignment] ?? .085;
    const offset=Math.min(chord*ratio, alignment==='Tight'?340:260);
    const b={x:a.x+ux*chord*.32+nx*offset,y:a.y+uy*chord*.32+ny*offset};
    const c={x:d.x-ux*chord*.32+nx*offset,y:d.y-uy*chord*.32+ny*offset};
    const samples=offset?sampleBezier(a,b,c,d):[a,d];
    let length=0; for(let i=1;i<samples.length;i++) length+=Math.hypot(samples[i].x-samples[i-1].x,samples[i].y-samples[i-1].y);
    return {path:samples.map(toLatLng),speed:speedFor(samples,speedCap(type)),length};
  }
  function offsetPath(points,offset) {
    const px=points.map(p=>map.latLngToLayerPoint(p));
    return px.map((p,i)=>{const before=px[Math.max(0,i-1)],after=px[Math.min(px.length-1,i+1)],dx=after.x-before.x,dy=after.y-before.y,len=Math.hypot(dx,dy)||1;return map.layerPointToLatLng(L.point(p.x-dy/len*offset,p.y+dx/len*offset));});
  }
  function lineFor(id) { return data.lines.find(line=>line.id===id); }
  function optionsForLines(select,value) {
    select.replaceChildren();
    const none=document.createElement('option'); none.value=''; none.textContent='Unassigned'; select.append(none);
    data.lines.forEach(line=>{const option=document.createElement('option');option.value=line.id;option.textContent=line.name;select.append(option);});
    select.value=value||'';
  }
  function save() { localStorage.setItem('dc-subway-builder-v4',JSON.stringify(data)); render(); }
  function snapshot() { return {data:JSON.parse(JSON.stringify(data)),selectedLine,activeTool,startNode:startNode?{...startNode}:null}; }
  function recordUndo() { undoStack.push(snapshot()); if(undoStack.length>100) undoStack.shift(); redoStack=[]; updateHistoryButtons(); }
  function updateHistoryButtons() { document.getElementById('undo').disabled=!undoStack.length; document.getElementById('redo').disabled=!redoStack.length; }
  function restore(state) { data=state.data; selectedLine=state.selectedLine; activeTool=state.activeTool; startNode=state.startNode; save(); updateControls(); updateHistoryButtons(); }
  function undo() { if(!undoStack.length)return;redoStack.push(snapshot());restore(undoStack.pop()); }
  function redo() { if(!redoStack.length)return;undoStack.push(snapshot());restore(redoStack.pop()); }
  document.getElementById('undo').onclick=undo;
  document.getElementById('redo').onclick=redo;
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&startNode){startNode=null;renderNodes();updateControls();status('Start node cleared. Select a node to begin a connection.');return;}
    if(!(event.ctrlKey||event.metaKey)||event.altKey)return;
    if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))return;
    if(event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?redo():undo();}
    else if(event.key.toLowerCase()==='y'){event.preventDefault();redo();}
  });

  function endpointConnected(track,index) {
    const point=track.points?.[index]; if(!point)return true;
    if(point.stationId||point.connectionId)return true;
    return data.tracks.some(other=>other.id!==track.id&&(other.points||[]).some(p=>map.distance([point.lat,point.lng],[p.lat,p.lng])<2));
  }
  function selectableNodes() {
    const nodes=data.stations.map(st=>({lat:st.lat,lng:st.lng,stationId:st.id,label:st.name,key:'station:'+st.id,kind:'station'}));
    data.tracks.forEach(track=>{
      if(!track.points?.length)return;
      [0,track.points.length-1].forEach(index=>{
        if(endpointConnected(track,index))return;
        const p=track.points[index]; nodes.push({lat:p.lat,lng:p.lng,connectionId:p.connectionId||null,label:'Open track end',key:`${track.id}:${index===0?'start':'end'}`,kind:'track'});
      });
    });
    return nodes;
  }
  function nearestNode(latlng) {
    const cursor=map.latLngToContainerPoint(latlng); let match=null,best=25;
    selectableNodes().forEach(node=>{const distance=cursor.distanceTo(map.latLngToContainerPoint([node.lat,node.lng]));if(distance<best){best=distance;match=node;}});
    return match;
  }
  function nodeRef(node) { return {lat:node.lat,lng:node.lng,stationId:node.stationId||null,connectionId:node.connectionId||null}; }
  function createTrack(a,b) {
    if(a.key===b.key){status('Choose a different destination node.');return;}
    const id='track-'+Date.now()+'-'+Math.random().toString(36).slice(2,7);
    const type=document.getElementById('track-type').value,alignment=document.getElementById('curve-style').value;
    const segment=makeSegment(a,b,type,alignment),lineId=document.getElementById('assign-line').value||null;
    recordUndo();
    data.tracks.push({id,points:[nodeRef(a),nodeRef(b)],segments:[{path:segment.path.map(p=>({lat:p.lat,lng:p.lng})),speed:segment.speed,length:segment.length}],lineId,type,count:document.getElementById('track-count').value,elevation:document.getElementById('elevation').value});
    startNode=null;save();updateControls();status(`Track connected ${a.label} to ${b.label} · ${segment.speed} mph.`);
  }
  function selectNode(node) {
    if(!startNode){startNode=node;renderNodes();updateControls();status(`${node.label} selected. Click a second node to build the track.`);return;}
    createTrack(startNode,node);
  }
  function renderNodes() {
    endpointLayer.clearLayers(); selectionLayer.clearLayers();
    selectableNodes().filter(node=>node.kind==='track').forEach(node=>L.circleMarker([node.lat,node.lng],{radius:6,color:'#fff',weight:2,fillColor:'#344253',fillOpacity:1,interactive:false}).addTo(endpointLayer));
    if(startNode)L.circleMarker([startNode.lat,startNode.lng],{radius:13,color:'#fff',weight:3,fillColor:'#177e89',fillOpacity:.35,interactive:false}).addTo(selectionLayer);
  }
  function updateControls() {
    const stationButton=document.getElementById('start-station'),trackButton=document.getElementById('start-track');
    stationButton.textContent=activeTool==='stations'?'Stop Building Stations':'Build Stations';
    trackButton.textContent=activeTool==='tracks'?'Stop Building Tracks':'Build Tracks';
    stationButton.classList.toggle('button-main',activeTool==='stations');trackButton.classList.toggle('button-main',activeTool==='tracks');
    document.getElementById('map').style.cursor=activeTool==='none'?'grab':'crosshair';
    const tip=document.getElementById('map-tip');
    tip.textContent=activeTool==='stations'?'Click the map to place station nodes':activeTool==='tracks'?(startNode?'Select a second station or open track end':'Select a station or open track end'):'Choose Build Stations or Build Tracks';
    renderNodes();
  }
  function render() {
    const lineList=document.getElementById('line-list'); lineList.replaceChildren();
    if(!data.lines.length){const empty=document.createElement('p');empty.className='hint';empty.textContent='No lines yet. Add one to assign tracks.';lineList.append(empty);}
    data.lines.forEach(line=>{const button=document.createElement('button');button.type='button';button.className='line-row'+(line.id===selectedLine?' active':'');button.innerHTML='<span class="swatch"></span><span class="line-name"></span><span class="line-count"></span>';button.querySelector('.swatch').style.background=line.color;button.querySelector('.line-name').textContent=line.name;button.querySelector('.line-count').textContent=data.tracks.filter(track=>track.lineId===line.id).length+' segments';button.onclick=()=>{selectedLine=line.id;document.getElementById('assign-line').value=line.id;render();status(line.name+' selected.');};lineList.append(button);});
    const assign=document.getElementById('assign-line');optionsForLines(assign,assign.value||selectedLine);
    trackLayer.clearLayers();stationLayer.clearLayers();let totalMiles=0;
    data.stations.forEach(station=>L.marker([station.lat,station.lng],{interactive:false,icon:L.divIcon({className:'station-icon',html:'<span class="station-symbol"></span><span class="station-name">'+station.name+'</span>',iconSize:[150,24],iconAnchor:[12,12]})}).addTo(stationLayer));
    data.tracks.forEach(track=>{
      if(!track.points||track.points.length<2)return;
      const saved=track.segments?.[0],segment=saved?.path?.length?{path:saved.path.map(p=>L.latLng(p.lat,p.lng)),speed:saved.speed||speedCap(track.type),length:saved.length||0}:makeSegment(track.points[0],track.points[1],track.type,'Standard');
      if(!segment.length){for(let i=1;i<segment.path.length;i++)segment.length+=map.distance(segment.path[i-1],segment.path[i]);}
      const assigned=lineFor(track.lineId),color=assigned?.color||'#697581',count=Number(track.count)||1;totalMiles+=segment.length/1609.344*count;
      const paths=Array.from({length:count},(_,i)=>offsetPath(segment.path,(i-(count-1)/2)*7));
      paths.forEach(path=>L.polyline(path,{color:'#fff',weight:9,opacity:.98,lineCap:'round',lineJoin:'round',dashArray:track.elevation==='Elevated'?'3 4':null,interactive:false}).addTo(trackLayer));
      paths.forEach(path=>L.polyline(path,{color,weight:4,opacity:1,lineCap:'round',lineJoin:'round',dashArray:track.elevation==='Elevated'?'3 4':null,interactive:false}).addTo(trackLayer));
      if(track.elevation==='Deep tunnel')paths.forEach(path=>L.polyline(path,{color:'#fff',weight:1,opacity:.95,dashArray:'2 5',interactive:false}).addTo(trackLayer));
      const middle=segment.path[Math.floor(segment.path.length/2)];
      L.marker(middle,{interactive:false,icon:L.divIcon({className:'speed-label-icon',html:'<span class="speed-label">'+segment.speed+' mph</span>',iconSize:[58,20],iconAnchor:[29,10]})}).addTo(trackLayer);
    });
    const stationList=document.getElementById('station-list');stationList.replaceChildren();
    if(!data.stations.length){const empty=document.createElement('p');empty.className='hint';empty.textContent='No stations built yet.';stationList.append(empty);}
    data.stations.forEach(station=>{const row=document.createElement('div');row.className='station-row';const label=document.createElement('span');label.textContent=station.name;const remove=document.createElement('button');remove.type='button';remove.className='station-delete';remove.textContent='Remove';remove.onclick=()=>{recordUndo();data.tracks.forEach(track=>track.points.forEach(point=>{if(point.stationId===station.id)point.stationId=null;}));data.stations=data.stations.filter(item=>item.id!==station.id);data.stations.forEach((item,index)=>item.name='Station '+(index+1));save();status('Station removed; its track ends are open again.');};row.append(label,remove);stationList.append(row);});
    const trackList=document.getElementById('track-list');trackList.replaceChildren();
    if(!data.tracks.length){const empty=document.createElement('p');empty.className='hint';empty.textContent='No track segments built yet.';trackList.append(empty);}
    data.tracks.forEach((track,index)=>{const row=document.createElement('div');row.className='track-row';const head=document.createElement('div');head.className='track-head';const dot=document.createElement('span');dot.className='track-dot';dot.style.background=lineFor(track.lineId)?.color||'#697581';const title=document.createElement('span');title.textContent=`Segment ${index+1}`;head.append(dot,title);const a=data.stations.find(st=>st.id===track.points?.[0]?.stationId)?.name||'Track end';const b=data.stations.find(st=>st.id===track.points?.[1]?.stationId)?.name||'Track end';const meta=document.createElement('div');meta.className='track-meta';meta.textContent=`${a} ↔ ${b} · ${track.type} · ${track.count} track${track.count==='1'?'':'s'} · ${track.elevation}`;const select=document.createElement('select');select.className='track-assign';select.setAttribute('aria-label',`Assign segment ${index+1} to a line`);optionsForLines(select,track.lineId);select.onchange=()=>{recordUndo();track.lineId=select.value||null;save();};const remove=document.createElement('button');remove.type='button';remove.className='remove-track';remove.textContent='Remove segment';remove.onclick=()=>{recordUndo();for(const point of track.points){if(!point.connectionId)continue;const key=point.connectionId;data.tracks.filter(item=>item.id!==track.id).forEach(item=>item.points.forEach(end=>{if(end.connectionId===key)end.connectionId=null;}));}data.tracks=data.tracks.filter(item=>item.id!==track.id);save();status('Track segment removed.');};row.append(head,meta,select,remove);trackList.append(row);});
    document.getElementById('station-total').textContent=data.stations.length;document.getElementById('track-total').textContent=data.tracks.length;document.getElementById('mile-total').textContent=totalMiles.toFixed(1);
    renderNodes();
  }

  document.getElementById('add-line').onclick=()=>{recordUndo();const index=data.lines.length,line={id:'line-'+Date.now(),name:`${lineNames[index%lineNames.length]} Line`,color:colors[index%colors.length]};data.lines.push(line);selectedLine=line.id;document.getElementById('assign-line').value=line.id;save();status(`${line.name} added and selected.`);};
  document.getElementById('assign-line').onchange=event=>{selectedLine=event.target.value||null;render();};
  document.getElementById('start-station').onclick=()=>{activeTool=activeTool==='stations'?'none':'stations';startNode=null;updateControls();status(activeTool==='stations'?'Click the map to place station nodes.':'Station placement stopped.');};
  document.getElementById('start-track').onclick=()=>{activeTool=activeTool==='tracks'?'none':'tracks';startNode=null;updateControls();status(activeTool==='tracks'?'Select a station or an open track end.':'Track building stopped.');};
  map.on('click',event=>{
    if(activeTool==='stations'){
      recordUndo();const station={id:'station-'+Date.now()+'-'+Math.random().toString(36).slice(2,5),name:'Station '+(data.stations.length+1),lat:event.latlng.lat,lng:event.latlng.lng};data.stations.push(station);save();updateControls();status(station.name+' placed.');return;
    }
    if(activeTool!=='tracks')return;
    const node=nearestNode(event.latlng);if(!node){status('Click an existing station or an open track end. Tracks connect nodes; they are not drawn across the map.');return;}selectNode(node);
  });
  map.on('contextmenu',event=>{event.originalEvent.preventDefault();if(startNode){startNode=null;renderNodes();updateControls();status('Start node cleared. Track building is still active.');}else if(activeTool!=='none'){activeTool='none';updateControls();status('Building stopped.');}});
  map.on('zoomend moveend',renderNodes);
  window.addEventListener('storage',event=>{if(event.key==='dc-subway-builder-v4'){try{data=JSON.parse(event.newValue)||{lines:[],tracks:[],stations:[]};render();}catch{}}});
  render();updateControls();updateHistoryButtons();
})();
