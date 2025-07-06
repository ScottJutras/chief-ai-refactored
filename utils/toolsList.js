// utils/toolsList.js

const toolsList = [
    // Shingle Roofing tools
    'roofing hammer', 'roofing nailer', 'utility knife', 'chalk line', 'roofing shovel', 
    'roof harness', 'ladder', 'roofing hatchet', 'tar bucket', 'caulking gun',
  
    // Metal Roofing tools
    'metal snips', 'seam roller', 'drill driver', 'riveting tool', 'sheet metal bender', 
    'clamps', 'safety harness', 'measuring tape', 'screw gun', 'snip shears',
  
    // Window Installation tools
    'caulking gun', 'putty knife', 'level', 'pry bar', 'utility knife', 
    'drill', 'tape measure', 'shims', 'glass cutter', 'vacuum suction cups',
  
    // Door Installation tools
    'hinge jig', 'chisel set', 'drill driver', 'hammer', 'tape measure', 
    'level', 'utility knife', 'screwdriver set', 'door lifter', 'nail set',
  
    // Vinyl Siding tools
    'siding removal tool', 'snap lock punch', 'zip tool', 'power saw', 'nail gun', 
    'measuring tape', 'chalk line', 'utility knife', 'ladder', 'caulking gun',
  
    // James Hardie tools
    'fiber cement shears', 'dust mask', 'circular saw with Hardie blade', 't-square', 'level', 
    'nail gun', 'measuring tape', 'chalk line', 'drill driver', 'caulking gun',
  
    // Composite Siding tools
    'miter saw', 'jigsaw', 'measuring tape', 'drill driver', 'clamps', 
    'level', 'chalk line', 'utility knife', 'nail gun', 'ladder',
  
    // Framing tools
    'framing hammer', 'nail gun', 'speed square', 'tape measure', 'chalk line', 
    'circular saw', 'level', 'framing square', 'pry bar', 'clamps',
  
    // Concrete Aggregate tools
    'wheelbarrow', 'shovel', 'trowel', 'concrete mixer', 'screed', 
    'float', 'edger', 'groover', 'bull float', 'rebar cutter',
  
    // Fence Building tools
    'post hole digger', 'auger', 'level', 'measuring tape', 'string line', 
    'nail gun', 'screwdriver', 'saw', 'shovel', 'wheelbarrow',
  
    // Exterior Railing Installation tools
    'drill', 'screwdriver', 'measuring tape', 'level', 'clamps', 
    'wrench set', 'saw', 'chalk line', 'utility knife', 'safety goggles',
  
    // Interior Railing Installation tools
    'drill driver', 'tape measure', 'level', 'chisel set', 'screwdriver', 
    'clamps', 'saw', 'mallet', 'wrench set', 'wood glue',
  
    // Stair Installation tools
    'circular saw', 'jigsaw', 'level', 'tape measure', 'clamps', 
    'framing square', 'drill driver', 'chisel', 'nail gun', 'sander',
  
    // Flooring Installations tools
    'flooring nailer', 'mallet', 'tape measure', 'chalk line', 'utility knife', 
    'spacers', 'level', 'pry bar', 'rubber mallet', 'floor scraper',
  
    // Carpet Installation tools
    'carpet stretcher', 'knee kicker', 'utility knife', 'seam roller', 'tape measure', 
    'carpet tucker', 'staple gun', 'power stretcher', 'pry bar', 'measuring wheel',
  
    // Hardwood Flooring Installation tools
    'flooring nailer', 'mallet', 'tape measure', 'chalk line', 'moisture meter', 
    'jamb saw', 'pry bar', 'utility knife', 'clamps', 'sander',
  
    // Tile Installation tools
    'tile cutter', 'notched trowel', 'spacers', 'grout float', 'level', 
    'tile nipper', 'rubber mallet', 'mixing bucket', 'sponge', 'measuring tape',
  
    // Bathroom Installation tools
    'pipe wrench', 'adjustable wrench', 'plumber’s tape', 'drill driver', 'utility knife', 
    'tile cutter', 'level', 'caulking gun', 'screwdriver set', 'bucket',
  
    // Household Appliance installation tools
    'drill driver', 'level', 'adjustable wrench', 'screwdriver set', 'measuring tape', 
    'appliance dolly', 'utility knife', 'plumber’s tape', 'hose clamp tool', 'electrical tester',
  
    // Drywalling Installation tools
    'drywall saw', 't-square', 'utility knife', 'drill', 'drywall lift', 
    'mud pan', 'taping knife', 'corner trowel', 'sanding block', 'dust mask',
  
    // Mudding and Taping Installation tools
    'mud pan', 'taping knife', 'corner trowel', 'joint knife', 'sanding block', 
    'drywall tape', 'mud mixer', 'utility knife', 'dust mask', 'drop cloth',
  
    // Painting tools
    'paint roller', 'paint tray', 'drop cloth', 'paintbrushes', 'painter’s tape', 
    'extension pole', 'paint scraper', 'ladder', 'stir sticks', 'roller frame',
  
    // Trim and Moulding Installation tools
    'miter saw', 'nail gun', 'measuring tape', 'level', 'clamps', 
    'caulking gun', 'utility knife', 'wood glue', 'sanding block', 'pry bar',
  
    // Electric Fireplace Installation tools
    'drill driver', 'level', 'screwdriver', 'wire stripper', 'measuring tape', 
    'utility knife', 'voltage tester', 'stud finder', 'conduit bender', 'plaster saw',
  
    // Gas Fireplace Installation tools
    'pipe wrench', 'adjustable wrench', 'drill driver', 'screwdriver', 'gas leak detector', 
    'utility knife', 'level', 'measuring tape', 'plumber’s tape', 'caulking gun',
  
    // Home Networking Installation tools
    'cable tester', 'crimping tool', 'wire stripper', 'network cable', 'drill driver', 
    'measuring tape', 'utility knife', 'label maker', 'patch panel', 'ethernet tester',
  
    // Home Security System Installation tools
    'drill driver', 'measuring tape', 'screwdriver', 'wire stripper', 'level', 
    'utility knife', 'cable clips', 'voltage tester', 'ladder', 'cordless drill',
  
    // Home Security Camera Installation tools
    'drill driver', 'screwdriver', 'measuring tape', 'ladder', 'cable tester', 
    'wire stripper', 'level', 'ethernet cable', 'conduit', 'anchor bolts',
  
    // Blinds and Window Covering Installation tools
    'drill driver', 'measuring tape', 'level', 'screwdriver', 'utility knife', 
    'brackets', 'anchors', 'step ladder', 'caulking gun', 'plumb line',
  
    // Brick and Masonry Installation tools
    'trowel', 'masonry hammer', 'level', 'jointers', 'mortar mixer', 
    'brick chisel', 'wheelbarrow', 'mason’s line', 'brick set', 'pointing tool'
    // Construction tools
  ,'hammer', 'nail gun', 'screwdriver', 'wrench set', 'power drill', 
  'tape measure', 'level', 'circular saw', 'utility knife', 'chalk line',

  // Plumbing tools
  'pipe wrench', 'adjustable wrench', 'plumber’s tape', 'pipe cutter', 'plunger', 
  'faucet key', 'drain snake', 'pipe bender', 'sealant', 'pliers',

  // Electrical tools
  'wire stripper', 'voltage tester', 'multimeter', 'screwdrivers', 'electrical tape', 
  'circuit finder', 'wire nuts', 'conduit bender', 'fish tape', 'cable cutter',

  // HVAC tools
  'manifold gauge set', 'refrigerant scale', 'vacuum pump', 'thermometer', 'pipe cutter', 
  'leak detector', 'drill', 'screwdriver', 'fin comb', 'duct tape',

  // Automotive tools
  'socket set', 'wrench set', 'screwdrivers', 'car jack', 'torque wrench', 
  'oil filter wrench', 'jumper cables', 'tire inflator', 'battery tester', 'brake bleeder kit',

  // Landscaping tools
  'shovel', 'rake', 'wheelbarrow', 'pruners', 'hedge trimmer', 
  'lawn mower', 'string trimmer', 'leaf blower', 'spade', 'garden hose'
  ];
  
  module.exports = toolsList;
  