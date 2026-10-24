const reduceMotion=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const menuButton=document.querySelector('.menu-toggle');
const nav=document.querySelector('.main-nav');

menuButton?.addEventListener('click',()=>{
  const open=nav.classList.toggle('open');
  menuButton.setAttribute('aria-expanded',String(open));
  menuButton.setAttribute('aria-label',open?'Close menu':'Open menu');
});
nav?.querySelectorAll('a').forEach(link=>link.addEventListener('click',()=>{
  nav.classList.remove('open');
  menuButton?.setAttribute('aria-expanded','false');
}));

const currentPath=window.location.pathname.replace(/\/$/,'/index.html');
nav?.querySelectorAll('a').forEach(link=>{
  const linkPath=new URL(link.href,window.location.href).pathname;
  if(linkPath===currentPath)link.setAttribute('aria-current','page');
});

const revealTargets=[...document.querySelectorAll('.reveal, .destination-card, .package-card, .gallery-item, .faq-list details, .destination-detail, .payment-cards article, .values-band article, .payment-flow article, .inclusion-list span')];
const siblingCounts=new Map();
revealTargets.forEach(node=>{
  node.classList.add('reveal');
  const parent=node.parentElement;
  const index=siblingCounts.get(parent)||0;
  siblingCounts.set(parent,index+1);
  node.style.setProperty('--reveal-delay',`${Math.min(index,4)*75}ms`);
});

if('IntersectionObserver' in window){
  const revealObserver=new IntersectionObserver(entries=>entries.forEach(entry=>{
    if(entry.isIntersecting){
      entry.target.classList.add('visible');
      revealObserver.unobserve(entry.target);
    }
  }),{threshold:.12,rootMargin:'0px 0px -24px 0px'});
  revealTargets.forEach(node=>revealObserver.observe(node));
}else{
  revealTargets.forEach(node=>node.classList.add('visible'));
}

const progress=document.createElement('div');
progress.className='scroll-progress';
progress.setAttribute('role','progressbar');
progress.setAttribute('aria-label','Page reading progress');
progress.setAttribute('aria-valuemin','0');
progress.setAttribute('aria-valuemax','100');
progress.setAttribute('aria-valuenow','0');
document.body.prepend(progress);
let progressFrame=0;
const updateProgress=()=>{
  if(progressFrame)return;
  progressFrame=requestAnimationFrame(()=>{
    const range=document.documentElement.scrollHeight-window.innerHeight;
    const value=range>0?Math.round((window.scrollY/range)*100):0;
    progress.style.transform=`scaleX(${value/100})`;
    progress.setAttribute('aria-valuenow',String(value));
    progressFrame=0;
  });
};
window.addEventListener('scroll',updateProgress,{passive:true});
window.addEventListener('resize',updateProgress,{passive:true});
updateProgress();

if(!reduceMotion&&window.matchMedia('(pointer: fine)').matches){
  document.querySelectorAll('.destination-card, .gallery-item').forEach(card=>{
    card.addEventListener('pointermove',event=>{
      const bounds=card.getBoundingClientRect();
      const x=((event.clientX-bounds.left)/bounds.width-.5)*-10;
      const y=((event.clientY-bounds.top)/bounds.height-.5)*-10;
      card.style.setProperty('--pointer-x',`${x.toFixed(1)}px`);
      card.style.setProperty('--pointer-y',`${y.toFixed(1)}px`);
    });
    card.addEventListener('pointerleave',()=>{
      card.style.setProperty('--pointer-x','0px');
      card.style.setProperty('--pointer-y','0px');
    });
  });
}

const extraDestinations=[
  {name:'Tsavo',image:'https://images.unsplash.com/photo-1549366021-9f761d450615?auto=format&fit=crop&w=1200&q=85',alt:'Giraffe standing in a warm-toned savannah',tag:'WILDERNESS · ROAD TRIP',category:'safari',best:'Big landscapes & road journeys',stay:'2–4 nights, tailored',copy:'A spacious landscape for a slower road trip, with room to pair different parts of the park in one itinerary.',detail:'Tsavo can be part of a southern Kenya route between Amboseli and the coast. We’ll shape the order around your dates and chosen stays.'},
  {name:'Naivasha & Nakuru',image:'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1200&q=85',alt:'Open Rift Valley landscape beneath a broad sky',tag:'LAKES · SCENIC STOPS',category:'highlands',best:'Scenery & a varied itinerary',stay:'2–3 nights, tailored',copy:'A change of pace with lakeside scenery, open viewpoints and flexible day trips through the Rift Valley.',detail:'This area can be a stop between Nairobi and western Kenya, or part of a longer route linking wildlife destinations.'},
  {name:'Lamu',image:'https://images.unsplash.com/photo-1533105079780-92b9be482077?auto=format&fit=crop&w=1200&q=85',alt:'Coastal architecture beside the sea',tag:'ISLAND · CULTURE',category:'coast',best:'Swahili culture & slow days',stay:'3+ nights, tailored',copy:'A coastal escape for travellers drawn to Swahili culture, old-town lanes and unhurried island days.',detail:'Lamu can be planned as a standalone coastal stay or paired with another region where flight timings fit.'}
];
const extraPackages=[
  {id:'bush-and-beach',name:'Wild to blue',place:'MARA & DIANI',days:'7 DAYS',category:'safari coast',duration:7,image:'https://images.unsplash.com/photo-1516426122078-c23e76319801?auto=format&fit=crop&w=1000&q=85',alt:'Elephants on the African plains',copy:'A classic change of scene: open-country game drives followed by slower days on the coast.',detail:'A sample route can combine a Mara stay with time at Diani. Flights, accommodation and inclusions are tailored to your dates and budget.'},
  {id:'rift-and-water',name:'Rift & water',place:'NAIVASHA & NAKURU',days:'3 DAYS',category:'lakes family',duration:3,image:'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1000&q=85',alt:'Rift Valley scenery',copy:'A short scenic break with time for lakeside views, open landscapes and a flexible pace.',detail:'Use this as a standalone short escape or a stop on a longer Kenya itinerary. Activities and stays are selected to suit your group.'},
  {id:'laikipia-slow-days',name:'Laikipia slow days',place:'LAIKIPIA',days:'5 DAYS',category:'safari highlands',duration:5,image:'https://images.unsplash.com/photo-1511497584788-876760111969?auto=format&fit=crop&w=1000&q=85',alt:'Sunlight through a green forest canopy',copy:'A slower conservancy stay with local guiding, quiet mornings and room to explore at your own pace.',detail:'Specific experiences depend on the selected conservancy and travel dates. We’ll confirm activities and inclusions in your quote.'}
];

function addDestinationCard(item,index){
  const card=document.createElement('article');
  card.className='destination-detail dynamic-card';
  card.dataset.category=item.category;
  card.dataset.search=(item.name+' '+item.tag+' '+item.best+' '+item.copy).toLowerCase();
  card.innerHTML='<img src="'+item.image+'" alt="'+item.alt+'"><div><span>0'+(index+5)+' / '+item.tag+'</span><h2>'+item.name+'</h2><p>'+item.copy+'</p><div class="card-facts"><span>Best for<strong>'+item.best+'</strong></span><span>Plan for<strong>'+item.stay+'</strong></span></div><details class="card-more"><summary>Plan this stop <span>+</span></summary><p>'+item.detail+'</p></details><a class="text-link" href="contact.html">Plan this destination <span>↗</span></a></div>';
  return card;
}

function addPackageCard(item){
  const card=document.createElement('article');
  card.className='package-card dynamic-card';
  card.id=item.id;
  card.dataset.category=item.category;
  card.dataset.duration=String(item.duration);
  card.dataset.search=(item.name+' '+item.place+' '+item.copy+' '+item.detail).toLowerCase();
  card.innerHTML='<div class="package-image"><img src="'+item.image+'" alt="'+item.alt+'"><span class="package-tag">'+item.days+' · SAMPLE ROUTE</span></div><div class="package-body"><p class="package-location">'+item.place+'</p><h3>'+item.name+'</h3><p>'+item.copy+'</p><details class="package-more"><summary>View itinerary notes <span>+</span></summary><p>'+item.detail+'</p></details><div class="package-meta"><span>Price <strong>Tailored quote</strong></span><a href="contact.html" aria-label="Enquire about '+item.name+'">↗</a></div></div>';
  return card;
}

function setupCardExplorer(grid,kind,filters){
  if(!grid)return;
  grid.classList.add(kind==='destinations'?'destination-card-grid':'package-card-grid');
  const cards=[...grid.children].filter(card=>card.matches('.destination-detail, .package-card'));
  const destinationCategories=['safari','safari highlands','coast','highlands safari'];
  const destinationInfo=[
    {category:'safari',best:'Wildlife & open plains',stay:'3–5 nights, tailored',copy:'Wide grasslands, acacia shade and a landscape made for taking your time. Plan game drives with a restful camp between them.'},
    {category:'safari highlands',best:'Elephants & mountain views',stay:'2–3 nights, tailored',copy:'Open country and mountain silhouettes set the scene for unhurried wildlife viewing and early starts when the light is soft.'},
    {category:'coast',best:'Beach time & coastal culture',stay:'3+ nights, tailored',copy:'White sand, warm water and a gentler pace. Leave time for the beach, coastal food and optional days on the water.'},
    {category:'highlands safari',best:'Conservancy stays & quiet',stay:'3+ nights, tailored',copy:'Greener highlands, quiet conservancy stays and a different rhythm for travellers who enjoy wide spaces and local guiding.'}
  ];
  cards.forEach(card=>{
    const title=card.querySelector('h2,h3')?.textContent||'';
    card.dataset.search=card.dataset.search||(title+' '+card.textContent).toLowerCase();
    if(kind==='destinations'&&!card.classList.contains('dynamic-card')){
      const index=cards.filter(item=>!item.classList.contains('dynamic-card')).indexOf(card);
      const info=destinationInfo[index];
      card.classList.remove('reverse');
      if(info){
        card.dataset.category=info.category;
        card.dataset.search=(title+' '+info.best+' '+info.copy).toLowerCase();
        const heading=card.querySelector('h2');
        const paragraph=card.querySelector('div p');
        if(index===1&&heading)heading.textContent='Amboseli';
        if(paragraph)paragraph.textContent=info.copy;
        const link=card.querySelector('a.text-link');
        if(link){link.href=index===0?'packages.html#into-the-open':index===1?'packages.html#under-a-big-sky':index===2?'packages.html#saltwater-days':'packages.html#laikipia-slow-days';}
        const facts=document.createElement('div');
        facts.className='card-facts';
        facts.innerHTML='<span>Best for<strong>'+info.best+'</strong></span><span>Plan for<strong>'+info.stay+'</strong></span>';
        paragraph?.after(facts);
      }
    }else if(!card.dataset.category){
      card.dataset.category=kind==='destinations'?destinationCategories[cards.indexOf(card)]||'safari':'wildlife';
    }
  });
  const toolbar=document.createElement('div');
  toolbar.className='card-toolbar section-wrap';
  const searchLabel=kind==='destinations'?'Search places, landscapes, experiences…':'Search trips, destinations, experiences…';
  toolbar.innerHTML='<label class="search-box"><span aria-hidden="true">⌕</span><input type="search" data-explorer-search placeholder="'+searchLabel+'" aria-label="'+(kind==='destinations'?'Search destinations':'Search packages')+'"></label><div class="filter-chips" role="group" aria-label="Filter '+kind+'">'+filters.map((filter,index)=>'<button type="button" data-explorer-filter="'+filter.value+'" aria-pressed="'+(index===0)+'">'+filter.label+'</button>').join('')+'</div>'+(kind==='packages'?'<label class="duration-filter"><span>Duration</span><select data-explorer-duration aria-label="Filter by trip duration"><option value="all">Any length</option><option value="short">1–3 days</option><option value="medium">4–6 days</option><option value="long">7+ days</option></select></label>':'');
  const count=document.createElement('p');
  count.className='results-count section-wrap';
  count.setAttribute('aria-live','polite');
  const empty=document.createElement('p');
  empty.className='empty-results section-wrap';
  empty.hidden=true;
  empty.textContent=kind==='destinations'?'No places match your search. Try a different region or keyword.':'No trips match your filters. Try another trip style or duration.';
  grid.before(toolbar,count);
  grid.after(empty);
  grid.dataset.explorerKind=kind;
  let activeFilter='all';
  let searchTerm='';
  let activeDuration='all';
  let pending=[];
  const update=()=>{
    pending.forEach(clearTimeout);
    pending=[];
    let visible=0;
    cards.forEach(card=>{
      const categories=(card.dataset.category||'').split(/\s+/);
      const duration=Number(card.dataset.duration||0);
      const durationMatch=activeDuration==='all'||(activeDuration==='short'&&duration<=3)||(activeDuration==='medium'&&duration>=4&&duration<=6)||(activeDuration==='long'&&duration>=7);
      const show=(activeFilter==='all'||categories.includes(activeFilter))&&(card.dataset.search||'').includes(searchTerm)&&durationMatch;
      if(show){
        visible++;
        card.hidden=false;
        card.classList.remove('filter-exit');
        card.classList.add('filter-enter');
        requestAnimationFrame(()=>card.classList.remove('filter-enter'));
      }else if(!card.hidden){
        card.classList.add('filter-exit');
        pending.push(setTimeout(()=>{card.hidden=true;card.classList.remove('filter-exit')},180));
      }
    });
    count.textContent='Showing '+visible+' '+(kind==='destinations'?'places':'journeys');
    empty.hidden=visible!==0;
  };
  toolbar.querySelectorAll('[data-explorer-filter]').forEach(button=>button.addEventListener('click',()=>{
    activeFilter=button.dataset.explorerFilter;
    toolbar.querySelectorAll('[data-explorer-filter]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
    update();
  }));
  toolbar.querySelector('[data-explorer-search]').addEventListener('input',event=>{searchTerm=event.target.value.trim().toLowerCase();update()});
  toolbar.querySelector('[data-explorer-duration]')?.addEventListener('change',event=>{activeDuration=event.target.value;update()});
  update();
}

const destinationGrid=document.querySelector('.destination-detail-grid');
if(destinationGrid){
  extraDestinations.forEach((item,index)=>destinationGrid.append(addDestinationCard(item,index)));
  setupCardExplorer(destinationGrid,'destinations',[
    {label:'All places',value:'all'},{label:'Safari',value:'safari'},{label:'Coast',value:'coast'},{label:'Highlands & lakes',value:'highlands'}
  ]);
}

const packageGrid=document.querySelector('.package-grid-page');
if(packageGrid){
  const existingPackages=[...packageGrid.querySelectorAll('.package-card')];
  const categories=['safari wildlife','safari wildlife','coast'];
  const durations=[4,5,6];
  const ids=['into-the-open','under-a-big-sky','saltwater-days'];
  const notes=[
    'Unhurried game drives, a handpicked camp and time to watch the Mara’s changing light.','Elephants at first light and a slow route through the wide southern landscapes.','Swahili flavours, sea air and a little more time on the Indian Ocean.'
  ];
  existingPackages.forEach((card,index)=>{
    card.id=ids[index]||'journey-'+(index+1);
    card.dataset.category=categories[index]||'wildlife';
    card.dataset.duration=String(durations[index]||0);
    card.dataset.search=(card.textContent+' '+notes[index]).toLowerCase();
    if(!card.querySelector('.package-more')){
      const detail=document.createElement('details');
      detail.className='package-more';
      detail.innerHTML='<summary>View itinerary notes <span>+</span></summary><p>'+notes[index]+' Accommodation, transport, guiding and inclusions are confirmed in your tailored quote.</p>';
      card.querySelector('.package-body')?.insertBefore(detail,card.querySelector('.package-meta'));
    }
  });
  extraPackages.forEach(item=>packageGrid.append(addPackageCard(item)));
  setupCardExplorer(packageGrid,'packages',[
    {label:'All trips',value:'all'},{label:'Safari',value:'safari'},{label:'Coast',value:'coast'},{label:'Family & scenic',value:'family'}
  ]);
}

const contactConfig=window.WHIZPERZ_CONTACT||{};
const phone=(contactConfig.phone||'').trim();
const whatsapp=(contactConfig.whatsapp||phone).trim();
const email=(contactConfig.email||'').trim();
const contactDock=document.createElement('nav');
contactDock.className='quick-enquiry notranslate';
contactDock.setAttribute('aria-label','Contact Whizperz Tours');
const iconMarkup={
  phone:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.7 3.8 9.4 3l2 4.5-1.8 1.7a15 15 0 0 0 5.2 5.2l1.7-1.8 4.5 2-.8 2.7a2 2 0 0 1-2.2 1.4C10.5 17.6 6.4 13.5 5.3 6a2 2 0 0 1 1.4-2.2Z"/></svg>',
  whatsapp:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.7a8 8 0 0 1-11.8 7L4 20l1.3-4A8 8 0 1 1 20 11.7Z"/><path d="M9 8.3c.2-.4.4-.4.7-.4h.4l.7 1.7-.7.8a6 6 0 0 0 2.4 2.4l.8-.7 1.7.7v.4c0 .3 0 .5-.4.7-.6.4-1.3.5-2 .3-2.1-.6-4.4-2.9-5-5-.2-.7-.1-1.4.3-2Z"/></svg>',
  email:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="m4.5 7 7.5 6 7.5-6"/></svg>'
};
function addContactAction(kind,label,url,newTab=false){
  const link=document.createElement('a');
  link.className='quick-enquiry-action quick-'+kind;
  link.href=url;
  link.innerHTML=iconMarkup[kind]+'<span>'+label+'</span>';
  link.setAttribute('aria-label',label+' Whizperz Tours');
  if(newTab){link.target='_blank';link.rel='noopener noreferrer';}
  contactDock.append(link);
}
if(phone)addContactAction('phone','Call','tel:'+phone.replace(/[^+\d]/g,''));
const whatsappDigits=whatsapp.replace(/\D/g,'');
if(whatsappDigits)addContactAction('whatsapp','WhatsApp','https://wa.me/'+whatsappDigits+'?text='+encodeURIComponent(contactConfig.message||'Hello Whizperz Tours, I would like to enquire about a trip.'),true);
if(email)addContactAction('email','Email','mailto:'+email+'?subject='+encodeURIComponent('Tour enquiry'));
if(contactDock.childElementCount)document.body.append(contactDock);

document.querySelectorAll('.contact-placeholder').forEach(placeholder=>{
  if(!phone&&!email)return;
  placeholder.textContent='';
  if(phone){const call=document.createElement('a');call.href='tel:'+phone.replace(/[^+\d]/g,'');call.textContent=phone;placeholder.append(call);}
  if(phone&&email)placeholder.append(' · ');
  if(email){const mail=document.createElement('a');mail.href='mailto:'+email;mail.textContent=email;placeholder.append(mail);}
});

document.querySelector('#enquiry-form')?.addEventListener('submit',event=>{
  event.preventDefault();
  const note=document.querySelector('#form-note');
  note.textContent='This preview does not send or store enquiries. Add the verified Whizperz contact email to connect this form.';
});
