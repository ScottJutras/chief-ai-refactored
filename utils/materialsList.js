// utils/materialsList.js

const materialsList = [
    // Construction materials
    'shingles', '2x4', 'drywall', 'concrete', 'cement', 'nails', 'screws', 'plywood', 'lumber',
    'insulation', 'roofing felt', 'flooring', 'paint', 'primer', 'caulk', 'grout', 'adhesive',
    'sealant', 'bricks', 'blocks', 'tiles', 'sand', 'gravel', 'rebar', 'plaster',
  
    // Shingle Roofing Materials
    'asphalt shingles', 'fiberglass shingles', 'roofing nails', 'roofing tar', 'drip edge', 
    'roofing underlayment', 'roofing adhesive', 'roof vents', 'ridge cap shingles', 'starter strip shingles',
  
    // Metal Roofing Materials
    'metal panels', 'metal shingles', 'fasteners', 'sealant tape', 'metal flashing', 
    'ridge cap', 'closure strips', 'gutter systems', 'snow guards', 'roofing screws',
  
    // Window Installation Materials
    'window frames', 'glass panes', 'window seals', 'caulking', 'shims', 
    'window flashing tape', 'drip cap', 'foam insulation', 'sash', 'window muntins',
  
    // Door Installation Materials
    'door frames', 'hinges', 'doorknobs', 'deadbolts', 'strike plates', 
    'thresholds', 'weather stripping', 'door sweeps', 'peepholes', 'door viewers',
  
    // Vinyl Siding Materials
    'vinyl panels', 'starter strips', 'j-channel', 'corner posts', 'soffit panels', 
    'fascia', 'utility trim', 'flashing tape', 'siding nails', 'undersill trim',
  
    // James Hardie Materials
    'fiber cement boards', 'hardieplank', 'hardieshingle', 'hardietrim', 'colorplus technology finish', 
    'hardiewrap', 'hardiebacker', 'hardiesoffit', 'hardiepanel', 'hardie battens',
  
    // Composite Siding Materials
    'composite panels', 'lap siding', 'composite trim', 'corner pieces', 'soffit boards', 
    'flashing', 'composite shingles', 'mounting blocks', 'vented soffit', 'fascia boards',
  
    // Framing Materials
    'studs', 'joists', 'beams', 'headers', 'sheathing', 'anchor bolts', 'hangers', 'nail plates',
  
    // Concrete Aggregate Materials
    'rebar', 'mesh', 'gravel', 'sand', 'cement mixer', 'formwork', 'expansion joints', 'sealant',
  
    // Fence Building Materials
    'fence posts', 'post caps', 'fence panels', 'concrete mix', 'gravel', 'gate hardware', 'lattice panels', 'stain',
  
    // Exterior Railing Installation Materials
    'balusters', 'rail posts', 'handrails', 'post caps', 'brackets', 'fasteners', 'stainless steel cables',
  
    // Interior Railing Installation Materials
    'handrails', 'newel posts', 'balusters', 'rail brackets', 'screws', 'wood glue', 'finish nails',
  
    // Stair Installation Materials
    'treads', 'risers', 'stringers', 'stair nosing', 'stair brackets', 'handrails', 'balusters',
  
    // Flooring Installations
    'underlayment', 'adhesive', 'flooring planks', 'transition strips', 'floor spacers', 'moisture barrier',
  
    // Carpet Installation Materials
    'carpet rolls', 'carpet padding', 'tack strips', 'staples', 'seam tape', 'carpet adhesive',
  
    // Hardwood Flooring Installation Materials
    'hardwood planks', 'nail gun', 'flooring nails', 'moisture barrier', 'flooring adhesive', 'transition strips',
  
    // Tile Installation Materials
    'ceramic tiles', 'grout', 'tile spacers', 'thin-set mortar', 'tile adhesive', 'tile cutter', 'sealant',
  
    // Bathroom Installation Materials
    'toilets', 'sinks', 'bathtubs', 'shower panels', 'faucets', 'plumbing pipes', 'vanity units', 'mirrors',
  
    // Household Appliances
    'refrigerators', 'dishwashers', 'microwaves', 'washing machines', 'dryers', 'stoves', 'ovens', 'freezers',
  
    // Drywalling Installation Materials
    'drywall sheets', 'joint tape', 'joint compound', 'corner beads', 'drywall screws', 'drywall saw',
  
    // Mudding and Taping Installation Materials
    'joint compound', 'taping knives', 'corner trowels', 'sanding blocks', 'mesh tape',
  
    // Painting Materials
    'paint rollers', 'brushes', 'drop cloths', 'painter’s tape', 'paint trays', 'primer', 'paint',
  
    // Trim and Moulding Installation Materials
    'baseboards', 'crown moulding', 'quarter round', 'trim adhesive', 'finish nails', 'caulking',
  
    // Electric Fireplace Installation Materials
    'electric fireplace units', 'mounting brackets', 'trim kits', 'power cords', 'remote controls',
  
    // Gas Fireplace Installation Materials
    'gas fireplace units', 'vent pipes', 'gas valves', 'log sets', 'thermostats', 'remote controls',
  
    // Home Networking Installation Materials
    'ethernet cables', 'network switches', 'routers', 'patch panels', 'keystone jacks', 'network outlets',
  
    // Home Security System Installation Materials
    'control panels', 'motion detectors', 'alarm sirens', 'door/window sensors', 'keypads',
  
    // Home Security Camera Installation Materials
    'security cameras', 'mounting brackets', 'power adapters', 'DVR/NVR systems', 'ethernet cables',
  
    // Blinds and Window Covering Installation Materials
    'blinds', 'curtain rods', 'brackets', 'mounting hardware', 'valances', 'tiebacks',
  
    // Brick and Masonry Installation Materials
    'bricks', 'mortar', 'trowels', 'masonry saws', 'levels', 'joint rakers', 'masonry sealer',
  
    // Plumbing materials
    'pipes', 'fittings', 'valves', 'sinks', 'toilets', 'faucets', 'hoses', 'water heaters',
    'pvc', 'copper pipe', 'p-trap', 'drainage system', 'plumbing tape',
  
    // Electrical materials
    'wiring', 'cables', 'outlets', 'switches', 'circuit breakers', 'fuse', 'conduit', 'junction box',
    'light fixtures', 'bulbs', 'transformer', 'voltage meter', 'extension cords',
  
    // HVAC materials
    'ductwork', 'thermostats', 'air filters', 'compressor', 'ventilation grilles',
    'insulated tubing', 'refrigerant', 'heat pump',
  
    // Automotive materials
    'engine oil', 'brake pads', 'tires', 'batteries', 'spark plugs', 'filters', 'coolant',
    'belts', 'hoses', 'headlights', 'wiper blades', 'transmission fluid',
  
    // Landscaping materials
    'topsoil', 'mulch', 'fertilizer', 'grass seed', 'pavers', 'stones', 'landscape fabric',
    'garden hose', 'sprinklers', 'weed killer',
  
    // Office supplies
    'paper', 'pens', 'folders', 'binders', 'ink cartridges', 'staplers', 'notebooks',
    'whiteboards', 'markers', 'labels', 'printer toner',
  
    // Retail & Miscellaneous
    'display racks', 'price tags', 'shopping bags', 'barcodes', 'cash register',
    'security tags', 'receipt paper', 'mannequins',
  
    // Technology
    'laptops', 'keyboards', 'monitors', 'mice', 'routers', 'servers', 'cables',
    'external hard drives', 'usb drives', 'headphones', 'webcams'
  ];
  
  module.exports = materialsList;
  