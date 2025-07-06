    const areaCodeMap = {
        // USA Area Codes
        '205': { country: 'USA', state: 'Alabama' },
        '251': { country: 'USA', state: 'Alabama' },
        '256': { country: 'USA', state: 'Alabama' },
        '334': { country: 'USA', state: 'Alabama' },
        '659': { country: 'USA', state: 'Alabama' },
        '938': { country: 'USA', state: 'Alabama' },
    
        '907': { country: 'USA', state: 'Alaska' },
    
        '480': { country: 'USA', state: 'Arizona' },
        '520': { country: 'USA', state: 'Arizona' },
        '602': { country: 'USA', state: 'Arizona' },
        '623': { country: 'USA', state: 'Arizona' },
        '928': { country: 'USA', state: 'Arizona' },
    
        '327': { country: 'USA', state: 'Arkansas' },
        '479': { country: 'USA', state: 'Arkansas' },
        '501': { country: 'USA', state: 'Arkansas' },
        '870': { country: 'USA', state: 'Arkansas' },
    
        '209': { country: 'USA', state: 'California' },
        '213': { country: 'USA', state: 'California' },
        '279': { country: 'USA', state: 'California' },
        '310': { country: 'USA', state: 'California' },
        '323': { country: 'USA', state: 'California' },
        '341': { country: 'USA', state: 'California' },
        '350': { country: 'USA', state: 'California' },
        '369': { country: 'USA', state: 'California' },
        '408': { country: 'USA', state: 'California' },
        '415': { country: 'USA', state: 'California' },
        '424': { country: 'USA', state: 'California' },
        '442': { country: 'USA', state: 'California' },
        '510': { country: 'USA', state: 'California' },
        '530': { country: 'USA', state: 'California' },
        '559': { country: 'USA', state: 'California' },
        '562': { country: 'USA', state: 'California' },
        '619': { country: 'USA', state: 'California' },
        '626': { country: 'USA', state: 'California' },
        '628': { country: 'USA', state: 'California' },
        '650': { country: 'USA', state: 'California' },
        '657': { country: 'USA', state: 'California' },
        '661': { country: 'USA', state: 'California' },
        '669': { country: 'USA', state: 'California' },
        '707': { country: 'USA', state: 'California' },
        '714': { country: 'USA', state: 'California' },
        '747': { country: 'USA', state: 'California' },
        '760': { country: 'USA', state: 'California' },
        '805': { country: 'USA', state: 'California' },
        '818': { country: 'USA', state: 'California' },
        '820': { country: 'USA', state: 'California' },
        '831': { country: 'USA', state: 'California' },
        '840': { country: 'USA', state: 'California' },
        '858': { country: 'USA', state: 'California' },
        '909': { country: 'USA', state: 'California' },
        '916': { country: 'USA', state: 'California' },
        '925': { country: 'USA', state: 'California' },
        '949': { country: 'USA', state: 'California' },
        '951': { country: 'USA', state: 'California' },
        '303': { country: 'USA', state: 'Colorado' },
    '719': { country: 'USA', state: 'Colorado' },
    '720': { country: 'USA', state: 'Colorado' },
    '970': { country: 'USA', state: 'Colorado' },
    '983': { country: 'USA', state: 'Colorado' },

    // Connecticut
    '203': { country: 'USA', state: 'Connecticut' },
    '475': { country: 'USA', state: 'Connecticut' },
    '860': { country: 'USA', state: 'Connecticut' },
    '959': { country: 'USA', state: 'Connecticut' },

    // Delaware
    '302': { country: 'USA', state: 'Delaware' },

    // Florida
    '239': { country: 'USA', state: 'Florida' },
    '305': { country: 'USA', state: 'Florida' },
    '321': { country: 'USA', state: 'Florida' },
    '324': { country: 'USA', state: 'Florida' },
    '352': { country: 'USA', state: 'Florida' },
    '386': { country: 'USA', state: 'Florida' },
    '407': { country: 'USA', state: 'Florida' },
    '448': { country: 'USA', state: 'Florida' },
    '561': { country: 'USA', state: 'Florida' },
    '645': { country: 'USA', state: 'Florida' },
    '656': { country: 'USA', state: 'Florida' },
    '689': { country: 'USA', state: 'Florida' },
    '727': { country: 'USA', state: 'Florida' },
    '728': { country: 'USA', state: 'Florida' },
    '754': { country: 'USA', state: 'Florida' },
    '772': { country: 'USA', state: 'Florida' },
    '786': { country: 'USA', state: 'Florida' },
    '813': { country: 'USA', state: 'Florida' },
    '850': { country: 'USA', state: 'Florida' },
    '863': { country: 'USA', state: 'Florida' },
    '904': { country: 'USA', state: 'Florida' },
    '941': { country: 'USA', state: 'Florida' },
    '954': { country: 'USA', state: 'Florida' },

    // Georgia
    '229': { country: 'USA', state: 'Georgia' },
    '404': { country: 'USA', state: 'Georgia' },
    '470': { country: 'USA', state: 'Georgia' },
    '478': { country: 'USA', state: 'Georgia' },
    '678': { country: 'USA', state: 'Georgia' },
    '706': { country: 'USA', state: 'Georgia' },
    '762': { country: 'USA', state: 'Georgia' },
    '770': { country: 'USA', state: 'Georgia' },
    '912': { country: 'USA', state: 'Georgia' },
    '943': { country: 'USA', state: 'Georgia' },

    // Hawaii
    '808': { country: 'USA', state: 'Hawaii' },

    // Idaho
    '208': { country: 'USA', state: 'Idaho' },
    '986': { country: 'USA', state: 'Idaho' },

    // Illinois
    '217': { country: 'USA', state: 'Illinois' },
    '224': { country: 'USA', state: 'Illinois' },
    '309': { country: 'USA', state: 'Illinois' },
    '312': { country: 'USA', state: 'Illinois' },
    '331': { country: 'USA', state: 'Illinois' },
    '447': { country: 'USA', state: 'Illinois' },
    '464': { country: 'USA', state: 'Illinois' },
    '618': { country: 'USA', state: 'Illinois' },
    '630': { country: 'USA', state: 'Illinois' },
    '708': { country: 'USA', state: 'Illinois' },
    '730': { country: 'USA', state: 'Illinois' },
    '773': { country: 'USA', state: 'Illinois' },
    '779': { country: 'USA', state: 'Illinois' },
    '815': { country: 'USA', state: 'Illinois' },
    '847': { country: 'USA', state: 'Illinois' },
    '861': { country: 'USA', state: 'Illinois' },
    '872': { country: 'USA', state: 'Illinois' },

    // Indiana
    '219': { country: 'USA', state: 'Indiana' },
    '260': { country: 'USA', state: 'Indiana' },
    '317': { country: 'USA', state: 'Indiana' },
    '463': { country: 'USA', state: 'Indiana' },
    '574': { country: 'USA', state: 'Indiana' },
    '765': { country: 'USA', state: 'Indiana' },
    '812': { country: 'USA', state: 'Indiana' },
    '930': { country: 'USA', state: 'Indiana' },

    // Iowa
    '319': { country: 'USA', state: 'Iowa' },
    '515': { country: 'USA', state: 'Iowa' },
    '563': { country: 'USA', state: 'Iowa' },
    '641': { country: 'USA', state: 'Iowa' },
    '712': { country: 'USA', state: 'Iowa' },

    // Kansas
    '316': { country: 'USA', state: 'Kansas' },
    '620': { country: 'USA', state: 'Kansas' },
    '785': { country: 'USA', state: 'Kansas' },
    '913': { country: 'USA', state: 'Kansas' },

    // Kentucky
    '270': { country: 'USA', state: 'Kentucky' },
    '364': { country: 'USA', state: 'Kentucky' },
    '502': { country: 'USA', state: 'Kentucky' },
    '606': { country: 'USA', state: 'Kentucky' },
    '859': { country: 'USA', state: 'Kentucky' },

    // Louisiana
    '225': { country: 'USA', state: 'Louisiana' },
    '318': { country: 'USA', state: 'Louisiana' },
    '337': { country: 'USA', state: 'Louisiana' },
    '504': { country: 'USA', state: 'Louisiana' },
    '985': { country: 'USA', state: 'Louisiana' },

    // Maine
    '207': { country: 'USA', state: 'Maine' },

    // Maryland
    '227': { country: 'USA', state: 'Maryland' },
    '240': { country: 'USA', state: 'Maryland' },
    '301': { country: 'USA', state: 'Maryland' },
    '410': { country: 'USA', state: 'Maryland' },
    '443': { country: 'USA', state: 'Maryland' },
    '667': { country: 'USA', state: 'Maryland' },

    // Massachusetts
    '339': { country: 'USA', state: 'Massachusetts' },
    '351': { country: 'USA', state: 'Massachusetts' },
    '413': { country: 'USA', state: 'Massachusetts' },
    '508': { country: 'USA', state: 'Massachusetts' },
    '617': { country: 'USA', state: 'Massachusetts' },
    '774': { country: 'USA', state: 'Massachusetts' },
    '781': { country: 'USA', state: 'Massachusetts' },
    '857': { country: 'USA', state: 'Massachusetts' },
    '978': { country: 'USA', state: 'Massachusetts' },

    // Michigan
    '231': { country: 'USA', state: 'Michigan' },
    '248': { country: 'USA', state: 'Michigan' },
    '269': { country: 'USA', state: 'Michigan' },
    '313': { country: 'USA', state: 'Michigan' },
    '517': { country: 'USA', state: 'Michigan' },
    '586': { country: 'USA', state: 'Michigan' },
    '616': { country: 'USA', state: 'Michigan' },
    '734': { country: 'USA', state: 'Michigan' },
    '810': { country: 'USA', state: 'Michigan' },
    '906': { country: 'USA', state: 'Michigan' },
    '947': { country: 'USA', state: 'Michigan' },
    '989': { country: 'USA', state: 'Michigan' },
    '218': { country: 'USA', state: 'Minnesota' },
    '320': { country: 'USA', state: 'Minnesota' },
    '507': { country: 'USA', state: 'Minnesota' },
    '612': { country: 'USA', state: 'Minnesota' },
    '651': { country: 'USA', state: 'Minnesota' },
    '763': { country: 'USA', state: 'Minnesota' },
    '952': { country: 'USA', state: 'Minnesota' },

    // Mississippi
    '228': { country: 'USA', state: 'Mississippi' },
    '601': { country: 'USA', state: 'Mississippi' },
    '662': { country: 'USA', state: 'Mississippi' },
    '769': { country: 'USA', state: 'Mississippi' },

    // Missouri
    '235': { country: 'USA', state: 'Missouri' },
    '314': { country: 'USA', state: 'Missouri' },
    '417': { country: 'USA', state: 'Missouri' },
    '557': { country: 'USA', state: 'Missouri' },
    '573': { country: 'USA', state: 'Missouri' },
    '636': { country: 'USA', state: 'Missouri' },
    '660': { country: 'USA', state: 'Missouri' },
    '816': { country: 'USA', state: 'Missouri' },
    '975': { country: 'USA', state: 'Missouri' },

    // Montana
    '406': { country: 'USA', state: 'Montana' },

    // Nebraska
    '308': { country: 'USA', state: 'Nebraska' },
    '402': { country: 'USA', state: 'Nebraska' },
    '531': { country: 'USA', state: 'Nebraska' },

    // Nevada
    '702': { country: 'USA', state: 'Nevada' },
    '725': { country: 'USA', state: 'Nevada' },
    '775': { country: 'USA', state: 'Nevada' },

    // New Hampshire
    '603': { country: 'USA', state: 'New Hampshire' },

    // New Jersey
    '201': { country: 'USA', state: 'New Jersey' },
    '551': { country: 'USA', state: 'New Jersey' },
    '609': { country: 'USA', state: 'New Jersey' },
    '640': { country: 'USA', state: 'New Jersey' },
    '732': { country: 'USA', state: 'New Jersey' },
    '848': { country: 'USA', state: 'New Jersey' },
    '856': { country: 'USA', state: 'New Jersey' },
    '862': { country: 'USA', state: 'New Jersey' },
    '908': { country: 'USA', state: 'New Jersey' },
    '973': { country: 'USA', state: 'New Jersey' },

    // New Mexico
    '505': { country: 'USA', state: 'New Mexico' },
    '575': { country: 'USA', state: 'New Mexico' },

    // New York
    '212': { country: 'USA', state: 'New York' },
    '315': { country: 'USA', state: 'New York' },
    '329': { country: 'USA', state: 'New York' },
    '332': { country: 'USA', state: 'New York' },
    '347': { country: 'USA', state: 'New York' },
    '363': { country: 'USA', state: 'New York' },
    '516': { country: 'USA', state: 'New York' },
    '518': { country: 'USA', state: 'New York' },
    '585': { country: 'USA', state: 'New York' },
    '607': { country: 'USA', state: 'New York' },
    '624': { country: 'USA', state: 'New York' },
    '631': { country: 'USA', state: 'New York' },
    '646': { country: 'USA', state: 'New York' },
    '680': { country: 'USA', state: 'New York' },
    '716': { country: 'USA', state: 'New York' },
    '718': { country: 'USA', state: 'New York' },
    '838': { country: 'USA', state: 'New York' },
    '845': { country: 'USA', state: 'New York' },
    '914': { country: 'USA', state: 'New York' },
    '917': { country: 'USA', state: 'New York' },
    '929': { country: 'USA', state: 'New York' },
    '934': { country: 'USA', state: 'New York' },

    // North Carolina
    '252': { country: 'USA', state: 'North Carolina' },
    '336': { country: 'USA', state: 'North Carolina' },
    '472': { country: 'USA', state: 'North Carolina' },
    '704': { country: 'USA', state: 'North Carolina' },
    '743': { country: 'USA', state: 'North Carolina' },
    '828': { country: 'USA', state: 'North Carolina' },
    '910': { country: 'USA', state: 'North Carolina' },
    '919': { country: 'USA', state: 'North Carolina' },
    '980': { country: 'USA', state: 'North Carolina' },
    '984': { country: 'USA', state: 'North Carolina' },

    // North Dakota
    '701': { country: 'USA', state: 'North Dakota' },

    // Ohio
    '216': { country: 'USA', state: 'Ohio' },
    '220': { country: 'USA', state: 'Ohio' },
    '234': { country: 'USA', state: 'Ohio' },
    '283': { country: 'USA', state: 'Ohio' },
    '326': { country: 'USA', state: 'Ohio' },
    '330': { country: 'USA', state: 'Ohio' },
    '380': { country: 'USA', state: 'Ohio' },
    '419': { country: 'USA', state: 'Ohio' },
    '436': { country: 'USA', state: 'Ohio' },
    '440': { country: 'USA', state: 'Ohio' },
    '513': { country: 'USA', state: 'Ohio' },
    '567': { country: 'USA', state: 'Ohio' },
    '614': { country: 'USA', state: 'Ohio' },
    '740': { country: 'USA', state: 'Ohio' },
    '937': { country: 'USA', state: 'Ohio' },

    // Oklahoma
    '405': { country: 'USA', state: 'Oklahoma' },
    '539': { country: 'USA', state: 'Oklahoma' },
    '572': { country: 'USA', state: 'Oklahoma' },
    '580': { country: 'USA', state: 'Oklahoma' },
    '918': { country: 'USA', state: 'Oklahoma' },

    // Oregon
    '458': { country: 'USA', state: 'Oregon' },
    '503': { country: 'USA', state: 'Oregon' },
    '541': { country: 'USA', state: 'Oregon' },
    '971': { country: 'USA', state: 'Oregon' },
'215': { country: 'USA', state: 'Pennsylvania' },
    '223': { country: 'USA', state: 'Pennsylvania' },
    '267': { country: 'USA', state: 'Pennsylvania' },
    '272': { country: 'USA', state: 'Pennsylvania' },
    '412': { country: 'USA', state: 'Pennsylvania' },
    '445': { country: 'USA', state: 'Pennsylvania' },
    '484': { country: 'USA', state: 'Pennsylvania' },
    '570': { country: 'USA', state: 'Pennsylvania' },
    '582': { country: 'USA', state: 'Pennsylvania' },
    '610': { country: 'USA', state: 'Pennsylvania' },
    '717': { country: 'USA', state: 'Pennsylvania' },
    '724': { country: 'USA', state: 'Pennsylvania' },
    '814': { country: 'USA', state: 'Pennsylvania' },
    '835': { country: 'USA', state: 'Pennsylvania' },
    '878': { country: 'USA', state: 'Pennsylvania' },

    // Rhode Island
    '401': { country: 'USA', state: 'Rhode Island' },

    // South Carolina
    '803': { country: 'USA', state: 'South Carolina' },
    '839': { country: 'USA', state: 'South Carolina' },
    '843': { country: 'USA', state: 'South Carolina' },
    '854': { country: 'USA', state: 'South Carolina' },
    '864': { country: 'USA', state: 'South Carolina' },

    // South Dakota
    '605': { country: 'USA', state: 'South Dakota' },

    // Tennessee
    '423': { country: 'USA', state: 'Tennessee' },
    '615': { country: 'USA', state: 'Tennessee' },
    '629': { country: 'USA', state: 'Tennessee' },
    '731': { country: 'USA', state: 'Tennessee' },
    '865': { country: 'USA', state: 'Tennessee' },
    '901': { country: 'USA', state: 'Tennessee' },
    '931': { country: 'USA', state: 'Tennessee' },

    // Texas
    '210': { country: 'USA', state: 'Texas' },
    '214': { country: 'USA', state: 'Texas' },
    '254': { country: 'USA', state: 'Texas' },
    '281': { country: 'USA', state: 'Texas' },
    '325': { country: 'USA', state: 'Texas' },
    '346': { country: 'USA', state: 'Texas' },
    '361': { country: 'USA', state: 'Texas' },
    '409': { country: 'USA', state: 'Texas' },
    '430': { country: 'USA', state: 'Texas' },
    '432': { country: 'USA', state: 'Texas' },
    '469': { country: 'USA', state: 'Texas' },
    '512': { country: 'USA', state: 'Texas' },
    '682': { country: 'USA', state: 'Texas' },
    '713': { country: 'USA', state: 'Texas' },
    '726': { country: 'USA', state: 'Texas' },
    '737': { country: 'USA', state: 'Texas' },
    '806': { country: 'USA', state: 'Texas' },
    '817': { country: 'USA', state: 'Texas' },
    '830': { country: 'USA', state: 'Texas' },
    '832': { country: 'USA', state: 'Texas' },
    '903': { country: 'USA', state: 'Texas' },
    '915': { country: 'USA', state: 'Texas' },
    '936': { country: 'USA', state: 'Texas' },
    '940': { country: 'USA', state: 'Texas' },
    '945': { country: 'USA', state: 'Texas' },
    '956': { country: 'USA', state: 'Texas' },
    '972': { country: 'USA', state: 'Texas' },
    '979': { country: 'USA', state: 'Texas' },

    // Utah
    '385': { country: 'USA', state: 'Utah' },
    '435': { country: 'USA', state: 'Utah' },
    '801': { country: 'USA', state: 'Utah' },

    // Vermont
    '802': { country: 'USA', state: 'Vermont' },

    // Virginia
    '276': { country: 'USA', state: 'Virginia' },
    '434': { country: 'USA', state: 'Virginia' },
    '540': { country: 'USA', state: 'Virginia' },
    '571': { country: 'USA', state: 'Virginia' },
    '686': { country: 'USA', state: 'Virginia' },
    '703': { country: 'USA', state: 'Virginia' },
    '757': { country: 'USA', state: 'Virginia' },
    '804': { country: 'USA', state: 'Virginia' },
    '826': { country: 'USA', state: 'Virginia' },
    '948': { country: 'USA', state: 'Virginia' },

    // Washington
    '206': { country: 'USA', state: 'Washington' },
    '253': { country: 'USA', state: 'Washington' },
    '360': { country: 'USA', state: 'Washington' },
    '425': { country: 'USA', state: 'Washington' },
    '509': { country: 'USA', state: 'Washington' },
    '564': { country: 'USA', state: 'Washington' },

    // Washington, DC
    '202': { country: 'USA', state: 'Washington, DC' },
    '771': { country: 'USA', state: 'Washington, DC' },

    // West Virginia
    '304': { country: 'USA', state: 'West Virginia' },
    '681': { country: 'USA', state: 'West Virginia' },

    // Wisconsin
    '262': { country: 'USA', state: 'Wisconsin' },
    '274': { country: 'USA', state: 'Wisconsin' },
    '353': { country: 'USA', state: 'Wisconsin' },
    '414': { country: 'USA', state: 'Wisconsin' },
    '534': { country: 'USA', state: 'Wisconsin' },
    '608': { country: 'USA', state: 'Wisconsin' },
    '715': { country: 'USA', state: 'Wisconsin' },
    '920': { country: 'USA', state: 'Wisconsin' },

    // Wyoming
    '307': { country: 'USA', state: 'Wyoming' },

    // Territories
    '684': { country: 'USA', state: 'American Samoa' },
    '671': { country: 'USA', state: 'Guam' },
    '670': { country: 'USA', state: 'Northern Mariana Islands' },
    '787': { country: 'USA', state: 'Puerto Rico' },
    '939': { country: 'USA', state: 'Puerto Rico' },
    '340': { country: 'USA', state: 'Virgin Islands' },

    
        // Canada Area Codes
        '780': { country: 'Canada', province: 'Alberta' },
        '368': { country: 'Canada', province: 'Alberta' },
        '587': { country: 'Canada', province: 'Alberta' },
        '403': { country: 'Canada', province: 'Alberta' },
        '825': { country: 'Canada', province: 'Alberta' },
    
        '236': { country: 'Canada', province: 'British Columbia' },
        '250': { country: 'Canada', province: 'British Columbia' },
        '672': { country: 'Canada', province: 'British Columbia' },
        '604': { country: 'Canada', province: 'British Columbia' },
        '778': { country: 'Canada', province: 'British Columbia' },
    
        '584': { country: 'Canada', province: 'Manitoba' },
        '431': { country: 'Canada', province: 'Manitoba' },
        '204': { country: 'Canada', province: 'Manitoba' },
    
        '428': { country: 'Canada', province: 'New Brunswick' },
        '506': { country: 'Canada', province: 'New Brunswick' },
    
        '709': { country: 'Canada', province: 'Newfoundland' },
        '879': { country: 'Canada', province: 'Newfoundland' },
    
        '867': { country: 'Canada', province: 'Northwest Territories' },
    
        '782': { country: 'Canada', province: 'Nova Scotia' },
        '902': { country: 'Canada', province: 'Nova Scotia' },
    
        '867': { country: 'Canada', province: 'Nunavut' },
    
        '905': { country: 'Canada', province: 'Ontario' },
        '249': { country: 'Canada', province: 'Ontario' },
        '647': { country: 'Canada', province: 'Ontario' },
        '519': { country: 'Canada', province: 'Ontario' },
        '343': { country: 'Canada', province: 'Ontario' },
        '742': { country: 'Canada', province: 'Ontario' },
        '382': { country: 'Canada', province: 'Ontario' },
        '807': { country: 'Canada', province: 'Ontario' },
        '548': { country: 'Canada', province: 'Ontario' },
        '753': { country: 'Canada', province: 'Ontario' },
        '683': { country: 'Canada', province: 'Ontario' },
        '437': { country: 'Canada', province: 'Ontario' },
        '365': { country: 'Canada', province: 'Ontario' },
        '226': { country: 'Canada', province: 'Ontario' },
        '613': { country: 'Canada', province: 'Ontario' },
        '416': { country: 'Canada', province: 'Ontario' },
        '289': { country: 'Canada', province: 'Ontario' },
        '705': { country: 'Canada', province: 'Ontario' },
    
        '902': { country: 'Canada', province: 'Prince Edward Island' },
        '782': { country: 'Canada', province: 'Prince Edward Island' },
    
        '438': { country: 'Canada', province: 'Quebec' },
        '367': { country: 'Canada', province: 'Quebec' },
        '514': { country: 'Canada', province: 'Quebec' },
        '418': { country: 'Canada', province: 'Quebec' },
        '450': { country: 'Canada', province: 'Quebec' },
        '873': { country: 'Canada', province: 'Quebec' },
        '468': { country: 'Canada', province: 'Quebec' },
        '354': { country: 'Canada', province: 'Quebec' },
        '819': { country: 'Canada', province: 'Quebec' },
        '263': { country: 'Canada', province: 'Quebec' },
        '579': { country: 'Canada', province: 'Quebec' },
        '581': { country: 'Canada', province: 'Quebec' },
    
        '639': { country: 'Canada', province: 'Saskatchewan' },
        '306': { country: 'Canada', province: 'Saskatchewan' },
        '474': { country: 'Canada', province: 'Saskatchewan' },
    
        '867': { country: 'Canada', province: 'Yukon' },
    };
    
    module.exports = areaCodeMap;
    
